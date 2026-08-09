// Rotas do painel (sessão) e da API interna (Bearer BACKEND_TOKEN).
// Toda ação administrativa entra na tabela auditoria.
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../plugins/auth.js';
import { COOKIE_SESSAO } from '../plugins/auth.js';
import type { AgenteCtx } from '../domain/agente/agente.js';
import {
  FILA_DISPARO, chaveRateHora, dispararManual, fecharManual, forcarExpiracao,
  getDisparosConfig, logEvento,
} from '../domain/funil.js';
import { aprovarCorrecao, rejeitarCorrecao } from '../domain/correcoes.js';
import { encaminharHumano } from '../domain/handoff.js';
import { decidirEnvioOperador } from '../domain/operador.js';
import { seedSandbox } from '../domain/seed.js';
import { LABEL_UPSELL } from '../services/chatwoot.js';
import { soDigitos } from '../lib/util.js';

const TAXA_UPSELL_SITE = 8.5; // referência: upsell do site converte ~8,5%

// Uma conversa da lista/detalhe: mesmos campos nos dois lugares, senão o painel
// atualiza a lista e o cabeçalho da conversa aberta fica mostrando dado velho.
const SELECT_CONVERSA = `
  SELECT c.*, w.order_id, w.order_number, w.customer_name, w.customer_phone, w.etapa, w.status AS funil_status,
    (SELECT COUNT(*)::int FROM mensagens_ia m WHERE m.conversa_id = c.id) AS mensagens,
    (SELECT COALESCE(SUM(m.custo),0)::numeric(12,6) FROM mensagens_ia m WHERE m.conversa_id = c.id) AS custo,
    (SELECT m.texto FROM mensagens_ia m WHERE m.conversa_id = c.id ORDER BY m.id DESC LIMIT 1) AS ultima_mensagem,
    (SELECT m.direcao FROM mensagens_ia m WHERE m.conversa_id = c.id ORDER BY m.id DESC LIMIT 1) AS ultima_direcao,
    (SELECT m.criado_em FROM mensagens_ia m WHERE m.conversa_id = c.id ORDER BY m.id DESC LIMIT 1) AS ultima_em
  FROM conversas c LEFT JOIN wa_upsell w ON w.id = c.wa_upsell_id`;

const mascarar = (s: string): string => (s ? `${s.slice(0, 4)}…${s.slice(-2)}` : '(vazio)');

export function adminRoutes(app: FastifyInstance, ctx: AgenteCtx, auth: Auth): void {
  const { cfg, db, redis } = ctx;

  const auditar = (usuario: string, acao: string, alvo: string | null, payload: unknown) =>
    db.query('INSERT INTO auditoria (usuario, acao, alvo, payload) VALUES ($1,$2,$3,$4)', [
      usuario, acao, alvo, payload ?? null,
    ]).catch(() => {});

  /* ===== auth do painel ===== */

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, // trava força bruta
  }, async (req, reply) => {
    const body = z.object({ user: z.string(), senha: z.string() }).parse(req.body ?? {});
    const okUser = body.user === cfg.ADMIN_USER;
    const okSenha = cfg.ADMIN_PASS_HASH ? await bcrypt.compare(body.senha, cfg.ADMIN_PASS_HASH) : false;
    if (!okUser || !okSenha) {
      await auditar(body.user, 'login_falhou', null, { ip: req.ip });
      return reply.code(401).send({ error: 'usuário ou senha inválidos' });
    }
    const { id, csrf } = await auth.criarSessao(body.user);
    reply.setCookie(COOKIE_SESSAO, id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.NODE_ENV === 'production',
      signed: true,
      maxAge: 7 * 24 * 3600,
    });
    await auditar(body.user, 'login', null, { ip: req.ip });
    return { ok: true, user: body.user, csrf };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await auth.destruirSessao(req);
    reply.clearCookie(COOKIE_SESSAO, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const sess = await auth.lerSessao(req);
    if (!sess) return reply.code(401).send({ error: 'unauthorized' });
    return { user: sess.user, csrf: sess.csrf };
  });

  /* ===== rotas autenticadas ===== */
  app.register(async (adm) => {
    adm.addHook('preHandler', auth.requireAdmin);
    const usuario = (req: any): string => req.adminUser ?? 'api';
    // :id não-numérico ia direto pro Postgres e voltava 500 cru (22P02).
    // NaN aqui vira 400 antes de tocar o banco.
    const idParam = (req: any, reply: any): number | null => {
      const n = Number(req.params?.id);
      if (!Number.isInteger(n) || n <= 0) {
        reply.code(400).send({ erro: 'id inválido' });
        return null;
      }
      return n;
    };

    /* ----- dashboard / funil ----- */
    adm.get('/api/dashboard', async (req) => {
      const q = req.query as any;
      const de = q.de || null; // YYYY-MM-DD (America/Sao_Paulo); '' vira null
      const ate = q.ate || null;
      const filtro = `store='hidrabene'
        AND ($1::date IS NULL OR (criado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
        AND ($2::date IS NULL OR (criado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)`;
      const cards = (
        await db.query(
          `SELECT
             COUNT(*) FILTER (WHERE disparo_status IN ('enviado','entregue'))::int AS disparos,
             COUNT(*) FILTER (WHERE disparo_status = 'entregue')::int AS entregues,
             COUNT(*) FILTER (WHERE pix_charge_id IS NOT NULL OR etapa IN ('pago','expirado'))::int AS aceites,
             COUNT(*) FILTER (WHERE etapa = 'pago')::int AS pagos,
             COUNT(*) FILTER (WHERE etapa = 'recusado')::int AS recusados,
             COUNT(*) FILTER (WHERE etapa = 'sem_resposta')::int AS sem_resposta,
             COUNT(*) FILTER (WHERE etapa = 'corrigir_sac' OR etapa = 'corrigido')::int AS correcoes,
             COUNT(*) FILTER (WHERE etapa = 'fora_do_fluxo')::int AS fora_do_fluxo
           FROM wa_upsell WHERE ${filtro}`,
          [de, ate],
        )
      ).rows[0];
      const receita = (
        await db.query(
          `SELECT COALESCE(SUM(valor),0)::numeric(12,2) AS receita FROM wa_upsell_pagamentos
           WHERE store='hidrabene'
             AND ($1::date IS NULL OR (pago_em AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
             AND ($2::date IS NULL OR (pago_em AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)`,
          [de, ate],
        )
      ).rows[0];
      const diario = (
        await db.query(
          `SELECT to_char((criado_em AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS dia,
             COUNT(*) FILTER (WHERE disparo_status IN ('enviado','entregue'))::int AS disparos,
             COUNT(*) FILTER (WHERE pix_charge_id IS NOT NULL OR etapa IN ('pago','expirado'))::int AS aceites,
             COUNT(*) FILTER (WHERE etapa='pago')::int AS pagos
           FROM wa_upsell WHERE ${filtro}
           GROUP BY 1 ORDER BY 1`,
          [de, ate],
        )
      ).rows;
      const d = Number(cards.disparos) || 0;
      return {
        cards: {
          ...cards,
          receita: Number(receita.receita),
          taxa_aceite: d ? Math.round((cards.aceites / d) * 1000) / 10 : 0,
          taxa_pago: d ? Math.round((cards.pagos / d) * 1000) / 10 : 0,
          referencia_site: TAXA_UPSELL_SITE,
        },
        diario,
      };
    });

    /* ----- fila ao vivo ----- */
    adm.get('/api/fila', async (req) => {
      const q = req.query as any;
      const limit = Math.min(Number(q.limit ?? 50), 500);
      const offset = Math.max(Number(q.offset ?? 0), 0);
      const vals: unknown[] = [];
      const conds: string[] = [`store = COALESCE($${vals.push(q.store ?? 'hidrabene')}, 'hidrabene')`];
      if (q.status) conds.push(`status = $${vals.push(q.status)}`);
      if (q.etapa) conds.push(`etapa = $${vals.push(q.etapa)}`);
      if (q.de) conds.push(`(criado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $${vals.push(q.de)}::date`);
      if (q.ate) conds.push(`(criado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $${vals.push(q.ate)}::date`);
      if (q.q) {
        // fone/CPF só entram na busca quando o termo tem dígitos —
        // senão LIKE '%%' casa com tudo e anula o filtro
        const buscaDig = soDigitos(q.q);
        const i = vals.push(`%${String(q.q)}%`);
        const partes = [`order_id::text LIKE $${i}`, `order_number LIKE $${i}`, `customer_name ILIKE $${i}`];
        if (buscaDig) {
          const j = vals.push(`%${buscaDig}%`);
          partes.push(`customer_phone LIKE $${j}`, `customer_cpf LIKE $${j}`);
        }
        conds.push(`(${partes.join(' OR ')})`);
      }
      const where = conds.join(' AND ');
      const total = (await db.query(`SELECT COUNT(*)::int AS n FROM wa_upsell WHERE ${where}`, vals)).rows[0].n;
      const rows = (
        await db.query(
          `SELECT * FROM wa_upsell WHERE ${where} ORDER BY criado_em DESC LIMIT ${limit} OFFSET ${offset}`,
          vals,
        )
      ).rows;
      return { total, rows };
    });

    adm.post('/api/fila/:store/:orderId/fechar', async (req) => {
      const { store, orderId } = req.params as any;
      const body = (req.body ?? {}) as any;
      await fecharManual(ctx, store, Number(orderId), body.motivo);
      await auditar(usuario(req), 'fila_fechar', `${store}:${orderId}`, body);
      return { ok: true };
    });

    adm.post('/api/fila/:store/:orderId/expirar', async (req) => {
      const { store, orderId } = req.params as any;
      await forcarExpiracao(ctx, store, Number(orderId));
      await auditar(usuario(req), 'fila_expirar', `${store}:${orderId}`, null);
      return { ok: true };
    });

    adm.post('/api/fila/:store/:orderId/reenviar', async (req) => {
      const { store, orderId } = req.params as any;
      await db.query(
        `UPDATE wa_upsell SET status='open', etapa='aguardando_confirmacao', disparo_status='fila',
           template_msg_id=NULL, criado_em=now(), atualizado_em=now()
         WHERE store=$1 AND order_id=$2 AND etapa <> 'pago'`, // 'pago' é estado final
        [store, Number(orderId)],
      );
      await redis.rpush(FILA_DISPARO, JSON.stringify({ store, order_id: Number(orderId) }));
      await auditar(usuario(req), 'fila_reenviar', `${store}:${orderId}`, null);
      return { ok: true };
    });

    /* ----- disparo controlado ----- */
    adm.get('/api/disparo', async () => {
      const config = await getDisparosConfig(ctx);
      const tamanhoFila = await redis.llen(FILA_DISPARO);
      const usadosHora = Number((await redis.get(chaveRateHora())) ?? 0);
      return { config, fila: tamanhoFila, usados_na_hora: usadosHora };
    });

    adm.put('/api/disparo', async (req) => {
      const body = z
        .object({
          modo: z.enum(['test', 'live']).optional(),
          cpf_filtro: z.array(z.string()).optional(),
          rate_por_hora: z.number().int().min(0).optional(),
          pausado: z.boolean().optional(),
          amostra_restante: z.number().int().min(0).nullable().optional(),
          debug_meta: z.boolean().optional(),
          metodos_permitidos: z.array(z.string()).optional(), // [] = todos
        })
        .parse(req.body ?? {});
      const atual = await getDisparosConfig(ctx);
      const novo = { ...atual, ...body };
      await db.query(
        `UPDATE disparos_config SET modo=$1, cpf_filtro=$2, rate_por_hora=$3, pausado=$4,
           amostra_restante=$5, debug_meta=$6, metodos_permitidos=$7, atualizado_em=now() WHERE id=1`,
        [novo.modo, (novo.cpf_filtro ?? []).map(soDigitos).filter(Boolean), novo.rate_por_hora,
         novo.pausado, novo.amostra_restante, novo.debug_meta,
         (novo.metodos_permitidos ?? []).map((m) => String(m).trim().toLowerCase()).filter(Boolean)],
      );
      await auditar(usuario(req), 'disparo_config', null, { antes: atual, depois: novo });
      return { ok: true, config: novo };
    });

    // Aba Logs: eventos do sistema com filtro (debug da Meta, erros, tudo)
    adm.get('/api/logs', async (req) => {
      const q = req.query as Record<string, string>;
      const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
      const tipo = q.tipo ?? 'tudo';
      const cond =
        tipo === 'debug' ? `WHERE payload->>'debug' IS NOT NULL`
        : tipo === 'erro' ? `WHERE payload->>'erro' IS NOT NULL`
        : tipo === 'funil' ? `WHERE payload->>'debug' IS NULL AND store <> 'pagarme'`
        : '';
      const rows = (
        await db.query(`SELECT id, store, payload, created_at FROM wa_events ${cond} ORDER BY id DESC LIMIT $1`, [limit])
      ).rows;
      const config = await getDisparosConfig(ctx);
      return { logs: rows, debug_meta: config.debug_meta };
    });

    adm.post('/api/disparo/manual', async (req, reply) => {
      const body = z.object({ order_id: z.coerce.number().int().positive() }).parse(req.body ?? {});
      const r = await dispararManual(ctx, 'hidrabene', body.order_id);
      await auditar(usuario(req), 'disparo_manual', `hidrabene:${body.order_id}`, r);
      if (!r.ok) return reply.code(400).send(r);
      return r;
    });

    /* ----- gestão da oferta (versionada) ----- */
    adm.get('/api/ofertas', async () => ({
      ofertas: (await db.query('SELECT * FROM ofertas ORDER BY id')).rows,
    }));

    adm.post('/api/ofertas', async (req) => {
      const body = z
        .object({
          nome: z.string().min(1),
          sku_yampi: z.string().min(1),
          preco: z.number().positive(),
          preco_de: z.number().positive().nullable().optional(),
          ativo: z.boolean().optional(),
          copies: z.record(z.string()).optional(),
        })
        .parse(req.body ?? {});
      if (body.ativo) await db.query('UPDATE ofertas SET ativo=false');
      const r = await db.query(
        `INSERT INTO ofertas (nome, sku_yampi, preco, preco_de, ativo, copies)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [body.nome, body.sku_yampi, body.preco, body.preco_de ?? null, body.ativo ?? false, body.copies ?? {}],
      );
      await auditar(usuario(req), 'oferta_criada', `oferta:${r.rows[0].id}`, body);
      return r.rows[0];
    });

    adm.put('/api/ofertas/:id', async (req, reply) => {
      const id = Number((req.params as any).id);
      const body = z
        .object({
          nome: z.string().min(1).optional(),
          sku_yampi: z.string().min(1).optional(),
          preco: z.number().positive().optional(),
          preco_de: z.number().positive().nullable().optional(),
          ativo: z.boolean().optional(),
          copies: z.record(z.string()).optional(),
        })
        .parse(req.body ?? {});
      const atual = (await db.query('SELECT * FROM ofertas WHERE id=$1', [id])).rows[0];
      if (!atual) return reply.code(404).send({ error: 'oferta não encontrada' });
      // Versionamento: snapshot ANTES de alterar (histórico de quem mudou o quê)
      await db.query('INSERT INTO ofertas_historico (oferta_id, snapshot, usuario) VALUES ($1,$2,$3)', [
        id, atual, usuario(req),
      ]);
      if (body.ativo) await db.query('UPDATE ofertas SET ativo=false WHERE id<>$1', [id]);
      const novo = { ...atual, ...body };
      await db.query(
        `UPDATE ofertas SET nome=$2, sku_yampi=$3, preco=$4, preco_de=$5, ativo=$6, copies=$7, atualizado_em=now()
         WHERE id=$1`,
        [id, novo.nome, novo.sku_yampi, novo.preco, novo.preco_de, novo.ativo, novo.copies],
      );
      await auditar(usuario(req), 'oferta_atualizada', `oferta:${id}`, body);
      return { ok: true };
    });

    adm.get('/api/ofertas/:id/historico', async (req) => ({
      historico: (
        await db.query('SELECT * FROM ofertas_historico WHERE oferta_id=$1 ORDER BY id DESC LIMIT 50', [
          Number((req.params as any).id),
        ])
      ).rows,
    }));

    /* ----- aprovações de correção ----- */
    adm.get('/api/aprovacoes', async (req) => {
      const status = (req.query as any).status ?? 'aguardando_aprovacao';
      return {
        correcoes: (
          await db.query(
            `SELECT c.*, w.store, w.order_id, w.order_number, w.customer_name
             FROM correcoes c JOIN wa_upsell w ON w.id = c.wa_upsell_id
             WHERE ($1 = 'todas' OR c.status = $1)
             ORDER BY c.criado_em DESC LIMIT 200`,
            [status],
          )
        ).rows,
      };
    });

    adm.post('/api/aprovacoes/:id/aprovar', async (req, reply) => {
      const r = await aprovarCorrecao(ctx, Number((req.params as any).id), usuario(req));
      if (!r.ok) return reply.code(400).send(r);
      return r;
    });

    adm.post('/api/aprovacoes/:id/rejeitar', async (req, reply) => {
      const body = (req.body ?? {}) as any;
      const r = await rejeitarCorrecao(ctx, Number((req.params as any).id), usuario(req), String(body.motivo ?? ''));
      if (!r.ok) return reply.code(400).send(r);
      return r;
    });

    /* ----- conversas (espelho somente-leitura; filtro/busca/paginação) ----- */
    adm.get('/api/conversas', async (req) => {
      const q = req.query as Record<string, string>;
      const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
      const offset = Math.max(Number(q.offset ?? 0), 0);
      const where: string[] = [];
      const vals: unknown[] = [];
      if (q.status === 'bot' || q.status === 'humano') {
        vals.push(q.status);
        where.push(`c.status = $${vals.length}`);
      }
      const busca = String(q.q ?? '').trim();
      if (busca) {
        // nome, fone, order_id ou número do pedido — um campo só de busca no painel
        vals.push(`%${busca}%`);
        where.push(
          `(w.customer_name ILIKE $${vals.length} OR w.customer_phone LIKE $${vals.length}
            OR w.order_id::text LIKE $${vals.length} OR w.order_number LIKE $${vals.length})`,
        );
      }
      const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
      vals.push(limit, offset);
      const rows = (
        await db.query(
          `${SELECT_CONVERSA}
           ${cond}
           ORDER BY c.atualizado_em DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
          vals,
        )
      ).rows;
      const total = Number(
        (
          await db.query(
            `SELECT COUNT(*)::int AS n FROM conversas c LEFT JOIN wa_upsell w ON w.id = c.wa_upsell_id ${cond}`,
            vals.slice(0, vals.length - 2),
          )
        ).rows[0]?.n ?? 0,
      );
      const linkBase = cfg.CHATWOOT_URL
        ? `${cfg.CHATWOOT_URL.replace(/\/$/, '')}/app/accounts/${cfg.CHATWOOT_ACCOUNT_ID}/conversations`
        : null;
      return { conversas: rows, total, limit, offset, chatwoot_link_base: linkBase };
    });

    // Uma conversa só: o painel usa pra manter o cabeçalho da conversa aberta
    // em dia (etapa, custo, contador) sem depender de achá-la na página da lista.
    adm.get('/api/conversas/:id', async (req, reply) => {
      const id = idParam(req, reply);
      if (id === null) return reply;
      const r = await db.query(`${SELECT_CONVERSA} WHERE c.id=$1`, [id]);
      if (!r.rows.length) return reply.code(404).send({ erro: 'conversa não encontrada' });
      return { conversa: r.rows[0] };
    });

    adm.get('/api/conversas/:id/mensagens', async (req, reply) => {
      const id = idParam(req, reply);
      if (id === null) return reply;
      return {
        mensagens: (
          await db.query('SELECT * FROM mensagens_ia WHERE conversa_id=$1 ORDER BY id LIMIT 500', [id])
        ).rows,
      };
    });

    // Assumir a conversa: o bot PARA de responder e o operador passa a falar.
    // Pré-requisito pra enviar mensagem pelo painel (sem isso, os dois falavam junto).
    adm.post('/api/conversas/:id/assumir', async (req, reply) => {
      const id = idParam(req, reply);
      if (id === null) return reply;
      const r = await db.query('SELECT * FROM conversas WHERE id=$1', [id]);
      if (!r.rows.length) return reply.code(404).send({ erro: 'conversa não encontrada' });
      await encaminharHumano(
        ctx,
        { id, chatwoot_conversation_id: r.rows[0].chatwoot_conversation_id },
        'assumida no painel',
        `Operador ${usuario(req)} assumiu a conversa pelo painel do upsell.`,
      );
      await auditar(usuario(req), 'conversa_assumida', `conversa:${id}`, null);
      return { ok: true };
    });

    // Devolver ao bot (volta a responder sozinho)
    adm.post('/api/conversas/:id/devolver', async (req, reply) => {
      const id = idParam(req, reply);
      if (id === null) return reply;
      const r = await db.query('SELECT * FROM conversas WHERE id=$1', [id]);
      if (!r.rows.length) return reply.code(404).send({ erro: 'conversa não encontrada' });
      await db.query(
        `UPDATE conversas SET status='bot', handoff_motivo=NULL, atualizado_em=now() WHERE id=$1`,
        [id],
      );
      const convId = r.rows[0].chatwoot_conversation_id;
      if (ctx.chatwoot && convId) {
        await ctx.chatwoot.setLabels(convId, [LABEL_UPSELL]).catch(() => {});
        if (cfg.CHATWOOT_AGENT_ID) {
          await ctx.chatwoot.atribuirAgente(convId, Number(cfg.CHATWOOT_AGENT_ID)).catch(() => {});
        }
      }
      await auditar(usuario(req), 'conversa_devolvida_ao_bot', `conversa:${id}`, null);
      return { ok: true };
    });

    // Enviar mensagem como operador (sai pelo Chatwoot, mesmo caminho do agente).
    adm.post('/api/conversas/:id/mensagem', async (req, reply) => {
      const id = idParam(req, reply);
      if (id === null) return reply;
      const body = z.object({ texto: z.string().trim().min(1).max(4000) }).parse(req.body ?? {});
      const r = await db.query(
        `SELECT c.*, w.customer_phone FROM conversas c
         LEFT JOIN wa_upsell w ON w.id = c.wa_upsell_id WHERE c.id=$1`,
        [id],
      );
      if (!r.rows.length) return reply.code(404).send({ erro: 'conversa não encontrada' });
      const conversa = r.rows[0];
      const cfgd = await getDisparosConfig(ctx);
      const decisao = decidirEnvioOperador({
        statusConversa: conversa.status,
        modo: cfgd.modo,
        fone: conversa.customer_phone,
        foneTeste: cfg.WA_FONE_TESTE,
        temChatwoot: Boolean(ctx.chatwoot && conversa.chatwoot_conversation_id),
      });
      if (!decisao.pode || !ctx.chatwoot) {
        return reply.code(400).send({ erro: decisao.pode ? 'conversa sem Chatwoot configurado' : decisao.mensagem });
      }
      try {
        await ctx.chatwoot.enviarMensagem(conversa.chatwoot_conversation_id, body.texto);
      } catch (e) {
        await logEvento(ctx, 'hidrabene', {
          erro: 'msg_operador_falhou',
          conversa_id: id,
          detalhe: String((e as Error).message).slice(0, 300),
        });
        return reply.code(502).send({ erro: `falha ao enviar: ${String((e as Error).message).slice(0, 200)}` });
      }
      await db.query(
        `INSERT INTO mensagens_ia (conversa_id, direcao, texto, contexto) VALUES ($1,'out',$2,$3)`,
        [id, body.texto, { origem: 'operador', usuario: usuario(req) }],
      );
      await db.query('UPDATE conversas SET atualizado_em=now() WHERE id=$1', [id]);
      await auditar(usuario(req), 'msg_operador', `conversa:${id}`, { texto: body.texto.slice(0, 200) });
      return { ok: true };
    });

    /* ----- relatórios ----- */
    adm.get('/api/relatorios', async (req) => {
      const q = req.query as any;
      const de = q.de || null; // '' vira null (senão $1::date quebra com 500)
      const ate = q.ate || null;
      const porEtapa = (
        await db.query(
          `SELECT etapa, status, COUNT(*)::int AS n FROM wa_upsell
           WHERE store='hidrabene'
             AND ($1::date IS NULL OR (criado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
             AND ($2::date IS NULL OR (criado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)
           GROUP BY etapa, status ORDER BY n DESC`,
          [de, ate],
        )
      ).rows;
      const ia = (
        await db.query(
          `SELECT COALESCE(SUM(tokens),0)::int AS tokens, COALESCE(SUM(custo),0)::numeric(12,4) AS custo,
                  COUNT(*) FILTER (WHERE direcao='out')::int AS respostas
           FROM mensagens_ia
           WHERE ($1::date IS NULL OR (criado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
             AND ($2::date IS NULL OR (criado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)`,
          [de, ate],
        )
      ).rows[0];
      const vendas = (
        await db.query(
          `SELECT COUNT(*)::int AS pagos, COALESCE(SUM(valor),0)::numeric(12,2) AS receita
           FROM wa_upsell_pagamentos WHERE store='hidrabene'
             AND ($1::date IS NULL OR (pago_em AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
             AND ($2::date IS NULL OR (pago_em AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)`,
          [de, ate],
        )
      ).rows[0];
      const pagos = Number(vendas.pagos) || 0;
      return {
        por_etapa: porEtapa,
        ia: { ...ia, custo_por_venda: pagos ? Number(ia.custo) / pagos : null },
        vendas,
        comparativo_site: { referencia_pct: TAXA_UPSELL_SITE },
      };
    });

    /* ----- config ----- */
    adm.get('/api/config', async () => {
      const config = await getDisparosConfig(ctx);
      const base = cfg.APP_DOMAIN ? `https://${cfg.APP_DOMAIN}` : '';
      return {
        modo: config.modo,
        fone_teste: cfg.WA_FONE_TESTE,
        integracoes: {
          yampi: Boolean(cfg.YAMPI_ALIAS && cfg.YAMPI_TOKEN && cfg.YAMPI_SECRET),
          pagarme: Boolean(cfg.PAGARME_SECRET_KEY),
          meta: Boolean(cfg.METAWA_TOKEN && cfg.METAWA_PHONE_ID),
          chatwoot: Boolean(cfg.CHATWOOT_URL && cfg.CHATWOOT_API_TOKEN),
          openai: Boolean(cfg.OPENAI_API_KEY),
          status_api: Boolean(cfg.STATUS_TOKEN),
        },
        credenciais_mascaradas: {
          YAMPI_TOKEN: mascarar(cfg.YAMPI_TOKEN),
          PAGARME_SECRET_KEY: mascarar(cfg.PAGARME_SECRET_KEY),
          METAWA_TOKEN: mascarar(cfg.METAWA_TOKEN),
          CHATWOOT_API_TOKEN: mascarar(cfg.CHATWOOT_API_TOKEN),
          OPENAI_API_KEY: mascarar(cfg.OPENAI_API_KEY),
          STATUS_TOKEN: mascarar(cfg.STATUS_TOKEN),
        },
        webhooks: {
          yampi: `${base}/webhook/yampi?t=${cfg.webhookTokenYampi}`,
          pagarme: `${base}/webhook/pagarme?t=${cfg.webhookTokenPagarme}`,
          chatwoot: `${base}/webhook/chatwoot?t=${cfg.webhookTokenChatwoot}`,
          meta: `${base}/webhook/meta`,
          // contingência: roteador (n8n) que não repassa a assinatura da Meta
          meta_router: `${base}/webhook/meta?t=${cfg.webhookTokenMeta}`,
        },
        modelo_ia: cfg.OPENAI_MODEL,
        template: cfg.WA_UPSELL_TEMPLATE_CONFIRMA,
        flow_id: cfg.WA_UPSELL_FLOW_ID,
        treinamento: config.treinamento,
      };
    });

    // Treinamento do agente IA (estilo de escrita) — editável, entra no system prompt
    adm.put('/api/treinamento', async (req) => {
      const body = z.object({ treinamento: z.string().max(20000) }).parse(req.body ?? {});
      await db.query('UPDATE disparos_config SET treinamento=$1, atualizado_em=now() WHERE id=1', [body.treinamento]);
      await auditar(usuario(req), 'treinamento_ia', null, { tamanho: body.treinamento.length });
      return { ok: true };
    });

    // Cria e ATIVA o webhook na Yampi apontando pra cá
    adm.post('/api/config/webhooks/yampi', async (req, reply) => {
      const body = (req.body ?? {}) as any;
      const events: string[] = body.events ?? ['order.created', 'order.paid', 'order.status.updated'];
      if (!cfg.APP_DOMAIN) return reply.code(400).send({ error: 'APP_DOMAIN não configurado' });
      const url = `https://${cfg.APP_DOMAIN}/webhook/yampi?t=${cfg.webhookTokenYampi}`;
      try {
        const r = await ctx.yampi.criarWebhookAtivo(url, events);
        await auditar(usuario(req), 'webhook_yampi_criado', url, { events });
        return { ok: true, webhook: r };
      } catch (e) {
        return reply.code(502).send({ error: String((e as Error).message).slice(0, 300) });
      }
    });

    // Diagnóstico: envia um texto pro fone de teste com as credenciais DO BACKEND
    adm.post('/api/config/test-send', async (req) => {
      try {
        const r = await ctx.meta.enviarTexto(cfg.WA_FONE_TESTE, '🔧 test-send do agente_upsell OK');
        await auditar(usuario(req), 'test_send', cfg.WA_FONE_TESTE, null);
        return { ok: true, meta: r };
      } catch (e) {
        return {
          ok: false,
          erro: String((e as Error).message).slice(0, 400),
          phone_id_definido: Boolean(cfg.METAWA_PHONE_ID),
          token_definido: Boolean(cfg.METAWA_TOKEN),
        };
      }
    });

    adm.get('/api/eventos', async (req) => ({
      eventos: (
        await db.query('SELECT * FROM wa_events ORDER BY id DESC LIMIT $1', [
          Math.min(Number((req.query as any).limit ?? 50), 500),
        ])
      ).rows,
    }));

    adm.get('/api/auditoria', async (req) => ({
      auditoria: (
        await db.query('SELECT * FROM auditoria ORDER BY id DESC LIMIT $1', [
          Math.min(Number((req.query as any).limit ?? 100), 500),
        ])
      ).rows,
    }));

    /* ----- compat operacional (mesmos caminhos do agente_ecom; Bearer) ----- */
    adm.get('/wa-upsell/fila', async (req) => {
      const limit = Math.min(Number((req.query as any).limit ?? 50), 500);
      return (await db.query('SELECT * FROM wa_upsell ORDER BY criado_em DESC LIMIT $1', [limit])).rows;
    });

    adm.post('/wa-upsell/close', async (req) => {
      const b = (req.body ?? {}) as any;
      await fecharManual(ctx, b.store ?? 'hidrabene', Number(b.order_id), b.motivo);
      await auditar(usuario(req), 'close_api', `${b.store ?? 'hidrabene'}:${b.order_id}`, b);
      return { ok: true };
    });

    adm.post('/wa-upsell/seed', async (req, reply) => {
      const b = (req.body ?? {}) as any;
      const r = await dispararManual(ctx, b.store ?? 'hidrabene', Number(b.order_id));
      if (!r.ok) return reply.code(404).send(r);
      return r;
    });

    adm.post('/wa-upsell/sandbox', async (req) => {
      await seedSandbox(db);
      await auditar(usuario(req), 'sandbox_reset', null, null);
      return { ok: true, casos: [900000001, 900000002, 900000003, 900000004] };
    });
  });

  // Registro de evento externo (ex.: n8n) — Bearer master
  app.post('/api/eventos', async (req, reply) => {
    if (!auth.ehBearerMaster(req)) return reply.code(401).send({ error: 'unauthorized' });
    await logEvento(ctx, 'hidrabene', (req.body ?? {}) as any);
    return { ok: true };
  });
}
