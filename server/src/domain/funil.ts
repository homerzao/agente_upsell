// Orquestrador do funil de upsell — porte 1:1 da lógica VALIDADA do agente_ecom,
// com disparo controlado (piloto/amostra/rate/kill switch) e Chatwoot.
// Todas as dependências entram via ctx (testável com fakes).
import crypto from 'node:crypto';
import type { Db } from '../db/pool.js';
import type { Config } from '../config.js';
import type { MetaService } from '../services/meta.js';
import type { YampiService } from '../services/yampi.js';
import type { PagarmeService } from '../services/pagarme.js';
import type { ChatwootService } from '../services/chatwoot.js';
import { LABEL_UPSELL } from '../services/chatwoot.js';
import { carbon, foneBr, primeiroNome, renderCopy, soDigitos, valorBr } from '../lib/util.js';
import { decidirDisparo, destinoMensagem, ehTransicaoParaPago, interpretarRespostaFlow } from './estados.js';
import { COPIES_DEFAULT } from './copies.js';
import { montarTemplateConfirma, montarTemplateTechSAC } from './template.js';
import type { DisparosConfig, Oferta, RespostaFlow, WaUpsellRow } from './tipos.js';

export const FILA_DISPARO = 'waup:fila_disparo';
export const FILA_META = 'waup:fila_meta';

export type RedisLike = {
  rpush(key: string, val: string): Promise<unknown>;
  lpush(key: string, val: string): Promise<unknown>;
  lpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seg: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  // set com 'EX', ttl, 'NX' (dedup de wamid): retorna 'OK' ou null.
  // Assinatura frouxa de propósito — os overloads do ioredis não unificam.
  set(...args: any[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

export type FunilCtx = {
  db: Db;
  redis: RedisLike;
  cfg: Config;
  meta: MetaService;
  yampi: YampiService;
  pagarme: PagarmeService;
  chatwoot: ChatwootService | null;
};

/* ===== helpers ===== */

// Log de evento/erro em wa_events — NUNCA lança (diagnóstico não derruba fluxo).
export async function logEvento(ctx: FunilCtx, store: string, payload: Record<string, unknown>): Promise<void> {
  await ctx.db.query('INSERT INTO wa_events (store, payload) VALUES ($1,$2)', [store, payload]).catch(() => {});
}

export async function waupSet(
  ctx: FunilCtx,
  store: string,
  orderId: number,
  campos: Record<string, unknown>,
): Promise<void> {
  const sets = ['atualizado_em=now()'];
  const vals: unknown[] = [store, orderId];
  for (const [k, v] of Object.entries(campos)) {
    vals.push(v);
    sets.push(`${k}=$${vals.length}`);
  }
  await ctx.db.query(`UPDATE wa_upsell SET ${sets.join(', ')} WHERE store=$1 AND order_id=$2`, vals);
}

export async function getRow(ctx: FunilCtx, store: string, orderId: number): Promise<WaUpsellRow | null> {
  const r = await ctx.db.query('SELECT * FROM wa_upsell WHERE store=$1 AND order_id=$2', [store, orderId]);
  return (r.rows[0] as WaUpsellRow) ?? null;
}

export async function getDisparosConfig(ctx: FunilCtx): Promise<DisparosConfig> {
  const r = await ctx.db.query('SELECT * FROM disparos_config WHERE id=1');
  const row = r.rows[0] ?? {};
  return {
    modo: row.modo === 'live' ? 'live' : 'test',
    cpf_filtro: row.cpf_filtro ?? [],
    rate_por_hora: row.rate_por_hora ?? 0,
    pausado: row.pausado ?? true,
    amostra_restante: row.amostra_restante ?? null,
    treinamento: row.treinamento ?? '',
    debug_meta: row.debug_meta ?? false,
    metodos_permitidos: row.metodos_permitidos ?? [],
  };
}

export async function getOferta(ctx: FunilCtx, ofertaId?: number | null): Promise<Oferta | null> {
  const r = ofertaId
    ? await ctx.db.query('SELECT * FROM ofertas WHERE id=$1', [ofertaId])
    : await ctx.db.query('SELECT * FROM ofertas WHERE ativo ORDER BY atualizado_em DESC LIMIT 1');
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, preco: Number(row.preco), preco_de: row.preco_de === null ? null : Number(row.preco_de) };
}

// Multi-oferta por faixa de ticket (10/08): escolhe a oferta ativa cuja faixa
// [ticket_min, ticket_max) contém o valor de PRODUTO do pedido (subtotal −
// desconto, sem frete). NULL = lado aberto; empate resolve por prioridade
// (maior vence), então a oferta "geral" (faixa toda NULL, prioridade 0)
// convive com faixas específicas por cima dela.
export async function escolherOferta(ctx: FunilCtx, valorProdutos: number | null): Promise<Oferta | null> {
  // Sem ticket calculável (payload sem os campos de valor): cai na oferta geral,
  // que é o comportamento de sempre — nunca deixar de disparar por dado faltando.
  const v = valorProdutos;
  const r = await ctx.db.query(
    `SELECT * FROM ofertas WHERE ativo
       AND ($1::numeric IS NULL OR ticket_min IS NULL OR $1::numeric >= ticket_min)
       AND ($1::numeric IS NULL OR ticket_max IS NULL OR $1::numeric < ticket_max)
     ORDER BY prioridade DESC, atualizado_em DESC LIMIT 1`,
    [v],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, preco: Number(row.preco), preco_de: row.preco_de === null ? null : Number(row.preco_de) };
}

// Dados normalizados de um pedido Yampi (webhook ou GET) — puro, coberto por teste.
export function normalizarPedidoYampi(o: any): {
  orderId: number;
  numero: string;
  metodo: string | null;
  status: string | null;
  nome: string | null;
  fone: string;
  cpf: string;
  email: string | null;
  endereco: string;
  customerId: number | null;
  valorProdutos: number | null;
} {
  const status = o.status?.data?.alias ?? o.status_alias ?? (typeof o.status === 'string' ? o.status : null);
  const cust = o.customer?.data ?? o.customer ?? {};
  const ship = o.shipping_address?.data ?? o.shipping_address ?? {};
  // Yampi manda a rua em `street` (não existe `address` no shipping_address)
  const endereco = [
    ship.street ?? ship.address,
    ship.number,
    ship.complement,
    ship.neighborhood,
    ship.city && `${ship.city}/${ship.uf ?? ship.state ?? ''}`,
    ship.zip_code && `CEP ${ship.zip_code}`,
  ]
    .filter(Boolean)
    .join(', ');
  // alias do meio de pagamento (pix, mastercard, visa, elo, amex, billet…)
  const pagamentos = o.payments?.data ?? o.payments ?? [];
  const metodo = (Array.isArray(pagamentos) ? pagamentos[0] : null)?.alias
    ?? o.payment?.data?.alias ?? o.payment?.alias ?? null;
  // Ticket de PRODUTO = produtos − desconto, SEM frete (régua das faixas de
  // oferta, definição do Jorge 10/08). Payload sem os campos → null, e a
  // escolha de oferta cai na geral em vez de travar o disparo.
  const num = (x: unknown) => (x === null || x === undefined || x === '' ? null : Number(x));
  const vProd = num(o.value_products);
  const vDesc = num(o.value_discount) ?? 0;
  const valorProdutos = vProd === null || Number.isNaN(vProd) ? null : Math.max(0, vProd - vDesc);
  return {
    orderId: Number(o.id),
    numero: String(o.number ?? ''),
    metodo: metodo ? String(metodo).toLowerCase() : null,
    status,
    nome: cust.name ?? ([cust.first_name, cust.last_name].filter(Boolean).join(' ') || null),
    fone: foneBr(cust.phone?.full_number ?? cust.phone ?? ''),
    cpf: soDigitos(cust.cpf ?? cust.document ?? ''),
    email: cust.email ?? null,
    endereco,
    customerId: cust.id ?? null,
    valorProdutos,
  };
}

const destino = (ctx: FunilCtx, modo: 'test' | 'live', fone: string | null) =>
  destinoMensagem(modo, foneBr(fone), ctx.cfg.WA_FONE_TESTE);

/* ===== 0. Pedido Yampi entrou (webhook order.*) ===== */

export async function processarPedidoYampi(ctx: FunilCtx, store: string, o: any): Promise<void> {
  if (!o || !o.id) throw new Error('pedido sem id');
  const p = normalizarPedidoYampi(o);
  const prev = await ctx.db.query('SELECT status FROM pedidos_status WHERE store=$1 AND order_id=$2', [store, p.orderId]);
  await ctx.db.query(
    `INSERT INTO pedidos_status (store, order_id, status, payload, atualizado_em)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (store, order_id) DO UPDATE SET status=EXCLUDED.status, payload=EXCLUDED.payload, atualizado_em=now()`,
    [store, p.orderId, p.status, o],
  );
  // Disparo SÓ na TRANSIÇÃO pra família paga (nunca re-dispara)
  const statusAnterior = prev.rows.length ? prev.rows[0].status : null;
  if (ehTransicaoParaPago(statusAnterior, p.status)) {
    await iniciarFunil(ctx, store, o).catch(async (e) => {
      await logEvento(ctx, store, { erro: 'iniciar_funil_falhou', order_id: p.orderId, detalhe: String((e as Error).message).slice(0, 300) });
    });
  }
}

/* ===== 1. Pedido virou pago -> registra e (se elegível) entra na fila de disparo ===== */

export async function iniciarFunil(ctx: FunilCtx, store: string, o: any): Promise<void> {
  const p = normalizarPedidoYampi(o);
  const cfgd = await getDisparosConfig(ctx);
  // Oferta escolhida pela FAIXA de ticket do pedido (produtos − desconto, sem frete)
  const oferta = await escolherOferta(ctx, p.valorProdutos);
  // Idade do pedido pelo created_at (a Yampi não manda paid_at no webhook)
  const criadoEm = carbon(o.created_at);
  const idadeHoras = criadoEm ? (Date.now() - new Date(criadoEm).getTime()) / 3_600_000 : null;
  const decisao = decidirDisparo(cfgd, p.cpf, Boolean(oferta), p.metodo, {
    status: p.status,
    idadeHoras,
    idadeMaxHoras: ctx.cfg.WA_UPSELL_IDADE_MAX_HORAS,
  });
  // Registra TODO pedido pago (mesmo fora do filtro) — o faturamento consulta
  // qualquer pedido e sempre recebe resposta (closed/fora_do_fluxo).
  let semOferta = false;
  // UMA OFERTA POR CLIENTE POR JANELA (pergunta do Jorge, 10/08): a chave da
  // tabela é (store, order_id), então dois PEDIDOS do mesmo cliente gerariam
  // duas ofertas — em 623 disparos aconteceu com 1 cliente real. Com ofertas
  // diferentes por faixa ficaria pior (Kit num pedido, FPS 90 no outro).
  // O pedido segue registrado (o faturamento consulta qualquer um), só não dispara.
  if (decisao.elegivel && p.fone) {
    const jaTem = await ctx.db.query(
      `SELECT order_id FROM wa_upsell
       WHERE store=$1 AND disparo_status IN ('fila','enviado','entregue')
         AND right(customer_phone, 8) = right($2, 8)
         AND criado_em > now() - ($3 || ' hours')::interval
       LIMIT 1`,
      [store, p.fone, ctx.cfg.WA_UPSELL_JANELA_CLIENTE_HORAS],
    );
    if (jaTem.rows.length) {
      await logEvento(ctx, store, {
        evento: 'cliente_ja_recebeu_oferta',
        order_id: p.orderId,
        pedido_anterior: jaTem.rows[0].order_id,
      });
      // O pedido AINDA recebe a confirmação (todo pedido merece a sua), só sem
      // oferta — repetir a oferta pro mesmo cliente queima a copy do "aparece
      // UMA única vez". Pedido do Jorge, 10/08. Marcador: oferta_id = NULL numa
      // row elegível; o flow lê isso e pula a tela do ticket.
      semOferta = true;
    }
  }
  const ins = await ctx.db.query(
    `INSERT INTO wa_upsell (store, order_id, order_number, customer_phone, customer_name, customer_cpf, customer_email, status, etapa, oferta_id, disparo_status, valor_produtos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (store, order_id) DO NOTHING RETURNING order_id`,
    [
      store, p.orderId, p.numero, p.fone, p.nome, p.cpf || null, p.email,
      decisao.elegivel ? 'open' : 'closed',
      decisao.elegivel ? 'aguardando_confirmacao' : 'fora_do_fluxo',
      // oferta_id NULL numa row elegível = "confirma sem oferta": o cliente
      // recebe a confirmação do pedido e pode corrigir dados, mas o flow pula
      // a tela do ticket (ele já viu a oferta hoje, em outro pedido).
      semOferta ? null : (oferta?.id ?? null),
      decisao.elegivel ? 'fila' : null,
      p.valorProdutos,
    ],
  );
  if (!ins.rows.length) return; // já iniciado (nunca re-dispara)
  if (!decisao.elegivel) return; // registrado para consulta; nenhum disparo
  // Amostragem: gate ATÔMICO — só consome slot se ainda houver (dois webhooks
  // simultâneos com amostra=1 não podem virar 2 disparos)
  if (cfgd.amostra_restante !== null) {
    const gate = await ctx.db.query(
      `UPDATE disparos_config SET amostra_restante = amostra_restante - 1, atualizado_em=now()
       WHERE id=1 AND amostra_restante IS NOT NULL AND amostra_restante > 0
       RETURNING amostra_restante`,
    );
    if (!gate.rows.length) {
      // perdeu a corrida: reverte a row pra fora_do_fluxo e não dispara
      await ctx.db.query(
        `UPDATE wa_upsell SET status='closed', etapa='fora_do_fluxo', disparo_status=NULL, atualizado_em=now()
         WHERE store=$1 AND order_id=$2`,
        [store, p.orderId],
      );
      return;
    }
  }
  await ctx.redis.rpush(FILA_DISPARO, JSON.stringify({ store, order_id: p.orderId }));
}

/* ===== 2. Fila de disparo (rate limit + kill switch) ===== */

export function chaveRateHora(agora: Date = new Date()): string {
  const iso = agora.toISOString(); // bucket por hora UTC
  return `waup:rate:${iso.slice(0, 13)}`;
}

// Drena a fila respeitando pausa e rate/hora. Chamado pelo sweeper (5s).
// A config é relida A CADA item: o kill switch precisa valer no meio do drain.
export async function processarFilaDisparo(ctx: FunilCtx): Promise<void> {
  for (;;) {
    const cfgd = await getDisparosConfig(ctx);
    if (cfgd.pausado) return; // kill switch: fila fica esperando
    if (cfgd.rate_por_hora > 0) {
      const usados = Number((await ctx.redis.get(chaveRateHora())) ?? 0);
      if (usados >= cfgd.rate_por_hora) return; // orçamento da hora esgotado
    }
    const item = await ctx.redis.lpop(FILA_DISPARO);
    if (!item) return;
    let ref: { store: string; order_id: number };
    try {
      ref = JSON.parse(item);
    } catch {
      continue;
    }
    const row = await getRow(ctx, ref.store, ref.order_id);
    // Só dispara se a row continua aberta esperando o template (auto-close/fechamento manual ganham)
    if (!row || row.status !== 'open' || row.etapa !== 'aguardando_confirmacao' || row.template_msg_id) continue;
    await dispararTemplate(ctx, row);
    const chave = chaveRateHora();
    await ctx.redis.incr(chave);
    await ctx.redis.expire(chave, 3700);
  }
}

export async function dispararTemplate(ctx: FunilCtx, row: WaUpsellRow): Promise<void> {
  const cfgd = await getDisparosConfig(ctx);
  // oferta_id NULL = "confirma sem oferta". NÃO cair no getOferta(null), que
  // devolveria a oferta ativa e mandaria a ARTE DO CUPOM no header — cliente
  // veria "+1 PROTETOR FPS 90" no topo e nenhuma oferta na tela.
  const semOferta = row.oferta_id === null || row.oferta_id === undefined;
  const oferta = semOferta ? null : await getOferta(ctx, row.oferta_id);
  const copies: Record<string, string> = semOferta
    ? { ...COPIES_DEFAULT, header_url: '', header_media_id: '' }
    : (oferta?.copies ?? {});
  if (!ctx.cfg.METAWA_TOKEN || !ctx.cfg.METAWA_PHONE_ID) {
    await waupSet(ctx, row.store, row.order_id, { etapa: 'erro_disparo', disparo_status: 'erro' });
    await logEvento(ctx, row.store, { erro: 'disparo_sem_credenciais_meta', order_id: row.order_id });
    return;
  }
  try {
    // Endereço/e-mail vêm do snapshot do pedido (webhook); fallback: GET na Yampi
    let snap = (await ctx.db.query('SELECT payload FROM pedidos_status WHERE store=$1 AND order_id=$2', [row.store, row.order_id])).rows[0]?.payload;
    if (!snap) snap = await ctx.yampi.getOrder(row.order_id);
    const p = normalizarPedidoYampi(snap ?? {});
    const nome = primeiroNome(row.customer_name);
    const payload = montarTemplateConfirma({
      to: destino(ctx, cfgd.modo, row.customer_phone),
      templateNome: (copies.template_nome || ctx.cfg.WA_UPSELL_TEMPLATE_CONFIRMA),
      flowToken: `${row.store}:${row.order_id}`,
      headerUrl: copies.header_url || ctx.cfg.WA_UPSELL_HEADER_URL || undefined,
      headerMediaId: copies.header_media_id || ctx.cfg.WA_UPSELL_HEADER_MEDIA_ID || undefined,
      copies,
      dados: {
        nome,
        nome_completo: row.customer_name ?? nome,
        numero: row.order_number ?? '',
        email: row.customer_email ?? p.email ?? '-',
        endereco: p.endereco || '-',
      },
    });
    // Caminho preferido: rota do TechSAC (cria a conversa TRAVADA e devolve o
    // conversation_id INTERNO, único jeito de destravar depois). Se falhar,
    // cai pro envio direto na Meta — disparo não pode parar por causa disso.
    let msgId: string | null = null;
    let internoTechSAC: number | null = null;
    let displayTechSAC: number | null = null;
    if (ctx.chatwoot && ctx.cfg.DISPARO_VIA_TECHSAC === '1') {
      try {
        const t = await ctx.chatwoot.enviarTemplateTechSAC(
          montarTemplateTechSAC({
            to: destino(ctx, cfgd.modo, row.customer_phone),
            contactName: row.customer_name ?? nome,
            templateNome: copies.template_nome || ctx.cfg.WA_UPSELL_TEMPLATE_CONFIRMA,
            flowToken: `${row.store}:${row.order_id}`,
            headerUrl: copies.header_url || ctx.cfg.WA_UPSELL_HEADER_URL || undefined,
            headerMediaId: copies.header_media_id || ctx.cfg.WA_UPSELL_HEADER_MEDIA_ID || undefined,
            copies,
            dados: {
              nome,
              nome_completo: row.customer_name ?? nome,
              numero: row.order_number ?? '',
              email: row.customer_email ?? p.email ?? '-',
              endereco: p.endereco || '-',
            },
          }),
        );
        internoTechSAC = t.conversationIdInterno;
        displayTechSAC = t.displayId;
        await logEvento(ctx, row.store, {
          evento: 'disparo_techsac',
          order_id: row.order_id,
          conversation_id_interno: internoTechSAC,
          display_id: displayTechSAC,
        });
      } catch (e) {
        await logEvento(ctx, row.store, {
          erro: 'disparo_techsac_falhou_usando_meta',
          order_id: row.order_id,
          detalhe: String((e as Error).message).slice(0, 300),
        });
      }
    }
    if (internoTechSAC === null && displayTechSAC === null) {
      const r = await ctx.meta.waSendRaw(payload);
      msgId = r.messages?.[0]?.id ?? null;
    }
    await waupSet(ctx, row.store, row.order_id, {
      template_msg_id: msgId,
      disparo_status: 'enviado',
      disparado_em: new Date().toISOString(),
    });
    await criarConversaChatwoot(ctx, row, cfgd.modo, { interno: internoTechSAC, display: displayTechSAC }).then(
      () => espelhoNota(ctx, row.store, row.order_id,
        `📨 Template de confirmação do pedido #${row.order_number ?? row.order_id} enviado pro cliente no WhatsApp (funil Ticket Dourado). Notas 🤖 abaixo = mensagens automáticas enviadas ao cliente.`),
      async (e) => {
        await logEvento(ctx, row.store, { erro: 'chatwoot_conversa_falhou', order_id: row.order_id, detalhe: String((e as Error).message).slice(0, 300) });
      },
    );
  } catch (e) {
    await waupSet(ctx, row.store, row.order_id, { etapa: 'erro_disparo', disparo_status: 'erro' });
    await logEvento(ctx, row.store, { erro_disparo: String((e as Error).message).slice(0, 300), order_id: row.order_id });
  }
}

// Localiza/cria a conversa do contato no Chatwoot e atribui ao agente IA.
export async function criarConversaChatwoot(
  ctx: FunilCtx,
  row: WaUpsellRow,
  modo: 'test' | 'live',
  ids?: { interno: number | null; display: number | null },
): Promise<number | null> {
  if (!ctx.chatwoot) return null;
  const fone = destino(ctx, modo, row.customer_phone);
  let contatoId: number | null = null;
  // Disparo pelo TechSAC já criou a conversa: usa o display que ele devolveu
  // (evita criar uma segunda conversa pro mesmo contato).
  let convId: number | null = ids?.display ?? null;
  if (!convId) {
    let contato = await ctx.chatwoot.buscarContatoPorFone(fone);
    if (!contato) contato = await ctx.chatwoot.criarContato(row.customer_name ?? 'Cliente Hidrabene', fone);
    contatoId = contato.id;
    const conv = await ctx.chatwoot.buscarOuCriarConversa(contato.id);
    convId = conv.id ?? conv.payload?.id ?? null;
  }
  if (!convId) throw new Error('conversa chatwoot sem id');
  await ctx.chatwoot.setLabels(convId, [LABEL_UPSELL]).catch(() => {});
  if (ctx.cfg.CHATWOOT_AGENT_ID) {
    await ctx.chatwoot.atribuirAgente(convId, Number(ctx.cfg.CHATWOOT_AGENT_ID)).catch(() => {});
  }
  await ctx.db.query(
    `INSERT INTO conversas (wa_upsell_id, chatwoot_conversation_id, chatwoot_contact_id, chatwoot_conv_interno, status)
     VALUES ($1,$2,$3,$4,'bot')
     ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET
       wa_upsell_id=EXCLUDED.wa_upsell_id,
       chatwoot_conv_interno=COALESCE(EXCLUDED.chatwoot_conv_interno, conversas.chatwoot_conv_interno),
       atualizado_em=now()`,
    [row.id, convId, contatoId, ids?.interno ?? null],
  );
  return Number(convId);
}

// Row do funil em CONTEXTO ATIVO pro fone: open, ou fechada há < 24h (pós-msg).
// fora_do_fluxo nunca conta — é SAC comum, não é conversa nossa.
// Espelho pro SAC: replica como NOTA INTERNA no Chatwoot o que saiu DIRETO pela
// Meta — atendente que abrir a conversa vê o funil inteiro (pedido do Jorge,
// 08/08/2026: "preciso que seja replicado como msg interna no chatwoot").
// Best-effort: falha do espelho NUNCA derruba o funil.
export async function espelhoNota(
  ctx: FunilCtx,
  store: string,
  orderId: number,
  texto: string,
  msgEnviadaAoCliente?: string,
): Promise<void> {
  try {
    const r = await ctx.db.query(
      `SELECT c.id, c.chatwoot_conversation_id AS cid FROM conversas c
       JOIN wa_upsell w ON w.id = c.wa_upsell_id
       WHERE w.store=$1 AND w.order_id=$2 ORDER BY c.id DESC LIMIT 1`,
      [store, orderId],
    );
    const conversa = r.rows[0];
    if (!conversa) return;
    // A mensagem que o FUNIL mandou entra no histórico do agente. Sem isso a IA
    // não sabe o que o sistema já falou com o cliente e contradiz o próprio
    // funil — no teste do Jorge (09/08) ela disse "a oferta encerrou" 14s depois
    // de o funil mandar o PIX, porque simplesmente não tinha visto o PIX sair.
    if (msgEnviadaAoCliente) {
      await ctx.db.query(
        `INSERT INTO mensagens_ia (conversa_id, direcao, texto, contexto) VALUES ($1,'out',$2,$3)`,
        [conversa.id, msgEnviadaAoCliente, { origem: 'funil' }],
      ).catch(() => {});
    }
    if (ctx.chatwoot && conversa.cid) await ctx.chatwoot.enviarMensagem(Number(conversa.cid), texto, true);
  } catch {
    /* espelho é só contexto */
  }
}

export async function buscarRowContextoAtivo(ctx: FunilCtx, fone: string): Promise<WaUpsellRow | null> {
  const dig = foneBr(fone);
  if (!dig) return null;
  // Match por DDD + ÚLTIMOS 8 DÍGITOS. Motivo (bug real 08/08): o wa_id da Meta
  // vem SEM o nono dígito (5591 92148793) e a Yampi grava COM (5591 992148793)
  // — comparar 11 dígitos falha e a mensagem do cliente era descartada como
  // "SAC comum". Os 8 finais + DDD identificam o assinante nos dois formatos.
  const r = await ctx.db.query(
    `SELECT * FROM wa_upsell
     WHERE store='hidrabene'
       AND right(customer_phone, 8) = right($1, 8)
       AND substring(customer_phone from 3 for 2) = substring($1 from 3 for 2)
       AND etapa <> 'fora_do_fluxo' AND disparo_status IS NOT NULL
       AND (status='open' OR atualizado_em > now() - interval '24 hours')
     ORDER BY criado_em DESC LIMIT 1`,
    [dig],
  );
  return (r.rows[0] as WaUpsellRow) ?? null;
}

/* ===== 3. Resposta do Flow (nfm_reply) ===== */

// Despedida no fechamento do flow — enviada UMA vez por row (claim atômico na flag).
export async function enviarDespedida(ctx: FunilCtx, row: WaUpsellRow): Promise<void> {
  const claim = await ctx.db.query(
    `UPDATE wa_upsell SET despedida_enviada=true, atualizado_em=now()
     WHERE store=$1 AND order_id=$2 AND despedida_enviada=false RETURNING order_id`,
    [row.store, row.order_id],
  );
  if (!claim.rows.length) return; // já enviada
  const cfgd = await getDisparosConfig(ctx);
  const oferta = await getOferta(ctx, row.oferta_id);
  const msg = renderCopy(oferta?.copies?.msg_despedida ?? '', {
    nome: primeiroNome(row.customer_name),
    numero: row.order_number ?? '',
  });
  if (!msg) return;
  await ctx.meta.enviarTexto(destino(ctx, cfgd.modo, row.customer_phone), msg).then(
    () => espelhoNota(ctx, row.store, row.order_id, `🤖 Enviado (WhatsApp): ${msg}`, msg),
    async (e) => {
      await logEvento(ctx, row.store, { erro: 'msg_despedida_falhou', order_id: row.order_id, detalhe: String((e as Error).message).slice(0, 300) });
    },
  );
}

export async function registrarResposta(ctx: FunilCtx, store: string, orderId: number, resposta: RespostaFlow): Promise<void> {
  const acao = interpretarRespostaFlow(resposta);
  // Flow pode ser re-executado (outra aba, replay do webhook): resposta tardia
  // NUNCA sobrescreve um pagamento já confirmado.
  const atual = await getRow(ctx, store, orderId);
  if (atual?.etapa === 'pago') return;
  // Metrificação do v8 (Jorge, 10/08): de ONDE veio a saída — 'ticket' (Pular na
  // tela da oferta) vs 'confirma' (Sair no double-check). Sem isso as duas
  // recusas chegam idênticas e o % de desistência do double-check não existe.
  const origem = (resposta as Record<string, unknown>).origem;
  if (origem) {
    await logEvento(ctx, store, { evento: 'flow_saida', order_id: orderId, origem: String(origem), acao });
  }
  if (acao === 'expirou_flow') {
    // Flow v6 fechou com oferta='expirada': o SERVIDOR já ocultou o ticket —
    // a row já está closed com a etapa certa; só a despedida sai.
    if (atual) await enviarDespedida(ctx, atual);
    return;
  }
  if (acao === 'corrigir') {
    // segue open: agente IA coleta a correção; aprovação humana aplica e fecha.
    // status open EXPLÍCITO: se o clique vier depois do auto-close de 4h, a row
    // reabre — pedido em correção NUNCA pode faturar (closed/corrigir_sac seria
    // lido pelo faturamento como "pode faturar").
    await waupSet(ctx, store, orderId, { status: 'open', etapa: 'corrigir_sac' });
    const row = await getRow(ctx, store, orderId);
    if (row) {
      const cfgd = await getDisparosConfig(ctx);
      const oferta = await getOferta(ctx, row.oferta_id);
      const msg = renderCopy(oferta?.copies?.msg_corrigir ?? '', {
        nome: primeiroNome(row.customer_name),
        numero: row.order_number ?? '',
      });
      if (msg) {
        await ctx.meta.enviarTexto(destino(ctx, cfgd.modo, row.customer_phone), msg).then(
          () => espelhoNota(ctx, store, orderId, `🤖 Enviado (WhatsApp): ${msg}\n\n✏️ Cliente pediu CORREÇÃO de dados — conversa segue com o agente/atendimento.`, msg),
          async (e) => {
            await logEvento(ctx, store, { erro: 'msg_corrigir_falhou', order_id: orderId, detalhe: String((e as Error).message).slice(0, 300) });
          },
        );
      }
    }
    return;
  }
  if (acao === 'aceitou') {
    await aceitarOferta(ctx, store, orderId);
    return;
  }
  if (acao === 'recusou') {
    if (atual?.status === 'open') {
      await waupSet(ctx, store, orderId, { status: 'closed', etapa: 'recusado' });
    }
    if (atual) await enviarDespedida(ctx, { ...atual, status: 'closed', etapa: 'recusado' });
    return;
  }
  if (acao === 'confirmou') {
    // nfm_reply de 'confirmar' é o fechamento TERMINAL do flow (o data_exchange
    // intermediário passa pelo /flow/upsell, não por aqui) — despedida sai.
    if (atual?.status === 'open') {
      await waupSet(ctx, store, orderId, { etapa: 'confirmado', abriu_flow_em: new Date().toISOString() });
    }
    if (atual) await enviarDespedida(ctx, atual);
  }
}

/* ===== 4. Cliente aceitou a oferta -> msg instantânea + PIX 5min ===== */

export async function aceitarOferta(ctx: FunilCtx, store: string, orderId: number): Promise<void> {
  const row = await getRow(ctx, store, orderId);
  if (!row) return;
  // Cliente consegue aceitar 2× (recarrega o flow, outra aba): idempotente
  if (['pix_enviado', 'pago'].includes(row.etapa)) return;
  if (row.status !== 'open') {
    // Aceite TARDIO: o cliente clicou, precisa de resposta — nunca silêncio.
    // (reusa a flag da despedida: um fechamento por row, sem mensagem dupla)
    const claim = await ctx.db.query(
      `UPDATE wa_upsell SET despedida_enviada=true, atualizado_em=now()
       WHERE store=$1 AND order_id=$2 AND despedida_enviada=false RETURNING order_id`,
      [store, orderId],
    );
    await logEvento(ctx, store, { evento: 'aceite_tardio', order_id: orderId, etapa: row.etapa });
    if (claim.rows.length) {
      const cfgdT = await getDisparosConfig(ctx);
      const ofertaT = await getOferta(ctx, row.oferta_id);
      const msg = renderCopy(ofertaT?.copies?.msg_aceite_tardio ?? '', {
        nome: primeiroNome(row.customer_name),
        numero: row.order_number ?? '',
      });
      if (msg) {
        await ctx.meta.enviarTexto(destino(ctx, cfgdT.modo, row.customer_phone), msg).then(
          () => espelhoNota(ctx, store, orderId, `🤖 Enviado (WhatsApp): ${msg}\n\n⏰ Cliente tentou aceitar a oferta FORA da janela.`, msg),
          async (e) => {
            await logEvento(ctx, store, { erro: 'msg_aceite_tardio_falhou', order_id: orderId, detalhe: String((e as Error).message).slice(0, 300) });
          },
        );
      }
    }
    return;
  }
  const cfgd = await getDisparosConfig(ctx);
  const oferta = await getOferta(ctx, row.oferta_id);
  if (!oferta || !ctx.cfg.PAGARME_SECRET_KEY) {
    await waupSet(ctx, store, orderId, { etapa: 'erro_disparo' });
    await logEvento(ctx, store, { erro: 'aceite_sem_oferta_ou_pagarme', order_id: orderId });
    return;
  }
  const cpf = soDigitos(row.customer_cpf ?? '');
  if (!cpf) {
    // Pagar.me recusa PIX sem document ("The customer Document is required")
    await waupSet(ctx, store, orderId, { etapa: 'erro_disparo' });
    await logEvento(ctx, store, { erro: 'pix_sem_cpf', order_id: orderId });
    return;
  }
  const nome = primeiroNome(row.customer_name);
  const fone = destino(ctx, cfgd.modo, row.customer_phone);
  const copies = oferta.copies ?? {};
  // Msg 1 sai NA HORA do aceite (resposta instantânea); o PIX gera logo em seguida.
  const msgAceite = renderCopy(copies.msg_aceite ?? '', {
    nome,
    produto: oferta.nome,
    preco: valorBr(oferta.preco),
    // prazo ANUNCIADO (menor que a validade real de propósito): cria urgência
    // sem perder quem paga 1-2 min depois
    minutos: ctx.cfg.WA_UPSELL_PIX_PRAZO_ANUNCIADO_MIN,
  });
  await ctx.meta.enviarTexto(fone, msgAceite).then(
    () => espelhoNota(ctx, store, orderId, `🏆 Cliente ACEITOU a oferta.\n\n🤖 Enviado (WhatsApp): ${msgAceite}`, msgAceite),
    async (e) => {
      await logEvento(ctx, store, { erro: 'msg_aceite_falhou', order_id: orderId, detalhe: String((e as Error).message).slice(0, 300) });
    },
  );

  const msgInstabilidade = () =>
    ctx.meta
      .enviarTexto(fone, renderCopy(copies.msg_pix_instabilidade ?? '', { nome }))
      .then(() => espelhoNota(ctx, store, orderId, '🤖 Enviado (WhatsApp): aviso de instabilidade no PIX (código não saiu — atenção do atendimento).'))
      .catch(async (e) => {
        // gotcha 7: até a mensagem de fallback loga a própria falha
        await logEvento(ctx, store, { erro: 'msg_instabilidade_falhou', order_id: orderId, detalhe: String((e as Error).message).slice(0, 300) });
      });

  let pix: { chargeId: string | null; codigo: string };
  try {
    pix = await ctx.pagarme.criarPix({
      code: `waup-${store}-${orderId}`,
      nome: row.customer_name ?? 'Cliente Hidrabene',
      email: row.customer_email ?? `waup-${orderId}@hidrabene.com.br`,
      cpf,
      fone: soDigitos(row.customer_phone),
      descricao: copies.pix_item_descricao ?? oferta.nome,
      valorCents: Math.round(oferta.preco * 100),
      sku: oferta.sku_yampi,
      expiresInSeg: ctx.cfg.WA_UPSELL_PIX_TTL_MIN * 60,
    });
  } catch (e) {
    // msg 1 já foi: NUNCA deixar o cliente esperando código fantasma
    await waupSet(ctx, store, orderId, { etapa: 'erro_disparo' });
    await logEvento(ctx, store, { erro: 'pix_criacao_falhou', order_id: orderId, detalhe: String((e as Error).message).slice(0, 300) });
    await msgInstabilidade();
    return;
  }
  await waupSet(ctx, store, orderId, {
    // status open EXPLÍCITO: se o auto-close de 4h correr junto com o aceite,
    // o PIX vivo reabre a row e o sweeper de 10min segue dono do fechamento
    status: 'open',
    etapa: 'pix_enviado',
    aceitou_em: new Date().toISOString(),
    pix_charge_id: pix.chargeId,
    pix_codigo: pix.codigo,
    pix_enviado_em: new Date().toISOString(),
    pix_expira_em: new Date(Date.now() + ctx.cfg.WA_UPSELL_PIX_TTL_MIN * 60 * 1000).toISOString(),
    // Token da página do PIX: 128 bits opacos, ESTÁVEL pela vida da row —
    // reenvio/PIX novo mantém o mesmo link, a página mostra o estado atual.
    pix_pagina_token: row.pix_pagina_token ?? crypto.randomBytes(16).toString('base64url'),
  });
  if (!pix.codigo) {
    await logEvento(ctx, store, { erro: 'pix_sem_qr_code', order_id: orderId, charge_id: pix.chargeId });
    await msgInstabilidade();
    return;
  }
  // Msg 2: SÓ o código (copy_code do template limita 15 chars; código tem ~220),
  // em mensagem de sessão separada pra facilitar copiar com 1 toque.
  try {
    await ctx.meta.enviarTexto(fone, pix.codigo);
    await espelhoNota(
      ctx, store, orderId,
      `🤖 Enviado (WhatsApp): código PIX copia-e-cola da oferta — R$ ${valorBr(oferta.preco)}, anunciado ${ctx.cfg.WA_UPSELL_PIX_PRAZO_ANUNCIADO_MIN} min / vale de fato ${ctx.cfg.WA_UPSELL_PIX_TTL_MIN} min (charge ${pix.chargeId ?? '?'}).`,
      // Marcador só pro histórico da IA (o cliente recebeu o CÓDIGO na linha
      // acima). Texto explícito porque no painel isso aparece como mensagem e
      // já assustou o Jorge achando que tinha ido pro cliente (09/08).
      '🔒 registro interno do sistema (não enviado ao cliente): o código PIX copia-e-cola foi entregue no WhatsApp',
    );
  } catch (e) {
    await logEvento(ctx, store, { erro: 'pix_msg_falhou', order_id: orderId, detalhe: String((e as Error).message).slice(0, 300) });
  }
}

/* ===== 5. Reenvio de PIX (tool do agente IA) ===== */

export async function reenviarPix(
  ctx: FunilCtx,
  store: string,
  orderId: number,
): Promise<{ ok: boolean; motivo?: string; reaproveitado?: boolean }> {
  const row = await getRow(ctx, store, orderId);
  if (!row) return { ok: false, motivo: 'pedido_fora_do_fluxo' };
  if (row.etapa === 'pago') return { ok: false, motivo: 'ja_pago' };
  // Pedido que nunca entrou no funil não pode ser reaberto/cobrado pelo agente
  if (row.etapa === 'fora_do_fluxo') return { ok: false, motivo: 'pedido_fora_do_fluxo' };
  // Cliente que NUNCA aceitou não pode ganhar PIX por atalho: o caminho abaixo
  // reabre a row como 'confirmado' e chama aceitarOferta, ou seja, aceitaria a
  // oferta no lugar dela e geraria cobrança que ela não pediu. Aceite só pelo
  // botão do flow. (Silvana, 09/08: mandou o comprovante do pedido do SITE 12s
  // depois do disparo e o agente se ofereceu pra "enviar o código correto".)
  if (row.etapa === 'aguardando_confirmacao' && !row.aceitou_em) {
    return { ok: false, motivo: 'cliente_ainda_nao_aceitou' };
  }
  const cfgd = await getDisparosConfig(ctx);
  // PIX ainda vivo: reenvia o MESMO código (idempotente — nunca cobrar 2×)
  if (row.etapa === 'pix_enviado' && row.pix_codigo && row.pix_expira_em && new Date(row.pix_expira_em) > new Date()) {
    await ctx.meta.enviarTexto(destino(ctx, cfgd.modo, row.customer_phone), row.pix_codigo).then(
      async () => {
        await espelhoNota(ctx, store, orderId, '🤖 Reenviado (WhatsApp): mesmo código PIX (ainda válido).');
        // Evento de SUCESSO (10/08): sem ele o monitor não distingue "IA disse
        // que reenviou e reenviou" de "disse e não reenviou" (alerta falso da Vanessa)
        await logEvento(ctx, store, { evento: 'reenvio_pix', order_id: orderId, reaproveitado: true });
        // Página SEMPRE junto do reenvio (Jorge, 10/08: "nessa 'não consegui'
        // já deveria ir o link") — quem pede reenvio quase sempre não CONSEGUIU
        // copiar; a página resolve o gesto. Best-effort: falha não derruba o reenvio.
        await enviarPaginaPix(ctx, store, orderId).catch(() => {});
      },
      async (e) => {
        await logEvento(ctx, store, { erro: 'reenvio_pix_falhou', order_id: orderId, detalhe: String((e as Error).message).slice(0, 300) });
      },
    );
    return { ok: true, reaproveitado: true };
  }
  // Expirado (ou fechado por expiração): reabre e gera PIX novo.
  // GOTCHA 20: registro RE-aberto reseta criado_em, senão o auto-close fecha na hora.
  await ctx.db.query(
    `UPDATE wa_upsell SET status='open', etapa='confirmado', pix_charge_id=NULL, pix_codigo=NULL,
       pix_enviado_em=NULL, pix_expira_em=NULL, criado_em=now(), atualizado_em=now()
     WHERE store=$1 AND order_id=$2`,
    [store, orderId],
  );
  await aceitarOferta(ctx, store, orderId);
  const depois = await getRow(ctx, store, orderId);
  if (depois?.etapa === 'pix_enviado' && depois.pix_codigo) {
    // Código NOVO também vai com a página (mesma decisão do Jorge, 10/08)
    await enviarPaginaPix(ctx, store, orderId).catch(() => {});
    return { ok: true };
  }
  return { ok: false, motivo: 'falha_ao_gerar_pix' };
}

/* ===== 5b. Página do PIX (link seguro com código inteiro + botão) ===== */

// Envia o par "texto com link solto" + "mensagem-botão cta_url" (decisão do
// Jorge, 10/08: "manda os 2, link solto e botão embaixo dele"). Usada pelo
// lembrete dos 7 min e pela tool enviar_pagina_pix do agente — nasceu de 3
// clientes num dia travadas em copiar o código certo dentro do WhatsApp.
export async function enviarPaginaPix(
  ctx: FunilCtx,
  store: string,
  orderId: number,
): Promise<{ ok: boolean; motivo?: string; link?: string }> {
  const row = await getRow(ctx, store, orderId);
  if (!row) return { ok: false, motivo: 'pedido_fora_do_fluxo' };
  if (row.etapa === 'pago') return { ok: false, motivo: 'ja_pago' };
  const vivo =
    row.etapa === 'pix_enviado' && row.pix_codigo && row.pix_expira_em && new Date(row.pix_expira_em) > new Date();
  // A página nunca mostra código morto — sem PIX vivo o link não ajuda ninguém
  if (!vivo) return { ok: false, motivo: 'pix_nao_esta_vivo_use_reenviar_pix_antes' };
  if (!row.pix_pagina_token) return { ok: false, motivo: 'sem_token_de_pagina' };
  const cfgd = await getDisparosConfig(ctx);
  const oferta = await getOferta(ctx, row.oferta_id);
  const copies = oferta?.copies ?? {};
  const nome = primeiroNome(row.customer_name);
  const link = `${ctx.cfg.PUBLIC_URL}/pix/${row.pix_pagina_token}`;
  const fone = destino(ctx, cfgd.modo, row.customer_phone);
  const msg = renderCopy(copies.msg_pagina_pix ?? COPIES_DEFAULT.msg_pagina_pix, { nome, link });
  try {
    // UMA bolha: corpo (texto + link) com o botão embaixo; se a Meta recusar
    // o interactive, cai pra texto puro com o link (nunca fica sem nada)
    await ctx.meta.enviarCtaUrl(fone, msg, 'ABRIR PÁGINA DO PIX', link).catch(async (e) => {
      await logEvento(ctx, store, { erro: 'pagina_pix_cta_falhou', order_id: orderId, detalhe: String((e as Error).message).slice(0, 200) });
      return ctx.meta.enviarTexto(fone, msg);
    });
    await espelhoNota(ctx, store, orderId, `🔗 Página do PIX enviada (link + botão na mesma mensagem): ${link}\n\n🤖 Enviado (WhatsApp): ${msg}`, msg);
    await logEvento(ctx, store, { evento: 'pagina_pix_enviada', order_id: orderId });
    return { ok: true, link };
  } catch (e) {
    await logEvento(ctx, store, { erro: 'pagina_pix_envio_falhou', order_id: orderId, detalhe: String((e as Error).message).slice(0, 300) });
    return { ok: false, motivo: 'falha_no_envio' };
  }
}

/* ===== 6. Pagamento confirmado (webhook Pagar.me) ===== */

export async function confirmarPagamento(ctx: FunilCtx, evento: any): Promise<boolean> {
  const charge = evento?.data?.charges?.[0] ?? evento?.data?.charge ?? evento?.data ?? {};
  const chargeId = charge?.id ?? evento?.data?.id;
  if (!chargeId) return false;
  const r = await ctx.db.query('SELECT * FROM wa_upsell WHERE pix_charge_id=$1', [chargeId]);
  const row = r.rows[0] as WaUpsellRow | undefined;
  if (!row) return false;
  const oferta = await getOferta(ctx, row.oferta_id);
  const valor = (charge?.amount ?? charge?.paid_amount ?? Math.round((oferta?.preco ?? 0) * 100)) / 100;
  // GOTCHA 10: Pagar.me manda charge.paid E order.paid pro MESMO pagamento —
  // dedup ATÔMICO: UNIQUE em pagarme_charge_id + ON CONFLICT DO NOTHING RETURNING;
  // sem retorno = duplicado, não enviar NADA de novo.
  const ins = await ctx.db.query(
    `INSERT INTO wa_upsell_pagamentos (store, order_id, pagarme_charge_id, pagarme_transaction_id, valor, sku, quantidade, pago_em, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)
     ON CONFLICT (pagarme_charge_id) DO NOTHING RETURNING id`,
    [row.store, row.order_id, chargeId, charge?.last_transaction?.id ?? null, valor, oferta?.sku_yampi ?? null, 1, evento],
  );
  if (!ins.rows.length) return true; // duplicado: já confirmado na primeira vez
  await waupSet(ctx, row.store, row.order_id, { status: 'closed', etapa: 'pago' });
  const cfgd = await getDisparosConfig(ctx);
  const copies = oferta?.copies ?? {};
  const nome = primeiroNome(row.customer_name);
  // Anotação no pedido da Yampi: equipe busca por "UPSELL WPP" no painel
  const anotacao = renderCopy(copies.anotacao_yampi ?? '', {
    produto: oferta?.nome ?? '',
    sku: oferta?.sku_yampi ?? '',
    qtd: 1,
    valor: valorBr(valor),
    charge_id: chargeId,
  });
  if (anotacao) {
    await ctx.yampi.comment(row.order_id, anotacao).catch(async (e) => {
      await logEvento(ctx, row.store, { erro: 'anotacao_yampi_falhou', order_id: row.order_id, detalhe: String((e as Error).message).slice(0, 200) });
    });
  }
  // Confirmação pro cliente: fecha o ciclo (🎉 + MESMO pedido + rastreio por aqui)
  const msgPago = renderCopy(copies.msg_pago ?? '', { nome });
  await ctx.meta
    .enviarTexto(destino(ctx, cfgd.modo, row.customer_phone), msgPago)
    .then(
      () => espelhoNota(ctx, row.store, row.order_id,
        `💰 OFERTA PAGA — R$ ${valorBr(valor)} via PIX (charge ${chargeId}). Faturamento adiciona o SKU ${oferta?.sku_yampi ?? '?'} ao pedido.\n\n🤖 Enviado (WhatsApp): ${msgPago}`,
        msgPago),
      async (e) => {
        await logEvento(ctx, row.store, { erro: 'confirmacao_pago_falhou', order_id: row.order_id, detalhe: String((e as Error).message).slice(0, 300) });
      },
    );
  return true;
}

/* ===== 7. Sweeper (por minuto) ===== */

export async function sweep(ctx: FunilCtx): Promise<void> {
  try {
    // Lembrete X min APÓS o envio do PIX ("vence em 3 minutos"), calibrado pelo
    // prazo ANUNCIADO — não pelo real, que é maior de propósito. No piloto real
    // (09/08) 2 de 3 clientes aceitaram e sumiram sem esse empurrão.
    // Uma vez por cobrança (flag lembrete_pix_em, tomada no próprio UPDATE).
    if (ctx.cfg.WA_UPSELL_LEMBRETE_PIX_APOS_MIN > 0) {
      const paraLembrar = await ctx.db.query(
        `UPDATE wa_upsell SET lembrete_pix_em=now()
         WHERE status='open' AND etapa='pix_enviado' AND store <> 'sandbox'
           AND lembrete_pix_em IS NULL AND pix_enviado_em IS NOT NULL
           AND pix_enviado_em < now() - ($1 || ' minutes')::interval
           AND (pix_expira_em IS NULL OR pix_expira_em > now())
         RETURNING store, order_id, customer_phone, customer_name, oferta_id, pix_pagina_token, pix_expira_em`,
        [ctx.cfg.WA_UPSELL_LEMBRETE_PIX_APOS_MIN],
      );
      for (const r of paraLembrar.rows) {
        const cfgd = await getDisparosConfig(ctx);
        const oferta = await getOferta(ctx, r.oferta_id);
        const nome = primeiroNome(r.customer_name);
        const fone = destino(ctx, cfgd.modo, r.customer_phone);
        // Minutos REAIS até expirar, calculados AGORA (Jorge, 10/08: o "vence
        // em 3 minutos" fixo era da era do prazo anunciado de 10 — a página
        // mostra o cronômetro real, então a copy tem que bater com ele)
        // Arredondado PRA BAIXO em múltiplo de 5 (Jorge, 10/08: "12 minutos"
        // fica feio — "10" lê melhor; entregar MAIS tempo que o dito é ok,
        // menos nunca). Abaixo de 5, vale o número exato.
        const exatos = Math.max(1, Math.floor((new Date(r.pix_expira_em).getTime() - Date.now()) / 60000));
        const minutosRest = exatos >= 5 ? Math.floor(exatos / 5) * 5 : exatos;
        // Página do PIX junto do lembrete (Jorge, 10/08): quem não pagou em 7
        // min muitas vezes é quem não CONSEGUIU copiar — o link resolve isso.
        const link = r.pix_pagina_token ? `${ctx.cfg.PUBLIC_URL}/pix/${r.pix_pagina_token}` : '';
        const copies = oferta?.copies ?? {};
        const partes = [
          renderCopy(
            copies.msg_lembrete_pix ??
              'Ó, {{nome}}: seu código PIX vence em pouquinho ⏱️\n\nÉ só colar no app do banco que o kit entra no seu pedido, sem frete extra.',
            { nome, minutos_restantes: minutosRest },
          ),
          link ? renderCopy(copies.msg_pagina_pix ?? COPIES_DEFAULT.msg_pagina_pix, { nome, link, minutos_restantes: minutosRest }) : '',
        ].filter(Boolean);
        const msg = partes.join('\n\n');
        // UMA bolha só: corpo (lembrete + link no texto) com o botão embaixo
        // (Jorge, 10/08: "pq nao faz link e botão na mesma msg?"). Se a Meta
        // recusar o interactive — ou a row for antiga, sem token — vai texto puro.
        const envio = link
          ? ctx.meta.enviarCtaUrl(fone, msg, 'ABRIR PÁGINA DO PIX', link).catch(async (e) => {
              await logEvento(ctx, r.store, { erro: 'pagina_pix_cta_falhou', order_id: r.order_id, detalhe: String((e as Error).message).slice(0, 200) });
              return ctx.meta.enviarTexto(fone, msg);
            })
          : ctx.meta.enviarTexto(fone, msg);
        await envio.then(
          () => espelhoNota(ctx, r.store, r.order_id, `⏱️ Lembrete de PIX enviado${link ? ` com a página do PIX (${link}) e botão na mesma mensagem` : ''}.\n\n🤖 Enviado (WhatsApp): ${msg}`, msg),
          async (e) => {
            await logEvento(ctx, r.store, { erro: 'lembrete_pix_falhou', order_id: r.order_id, detalhe: String((e as Error).message).slice(0, 200) });
          },
        );
      }
    }
    // PIX vencido: fecha expirado. Cancelamento na Pagar.me é best-effort —
    // GOTCHA 11: charge pending responde 412 (esperado); o QR morre sozinho.
    const venc = await ctx.db.query(
      `SELECT store, order_id, order_number, pix_charge_id, customer_phone, customer_name, oferta_id
       FROM wa_upsell
       WHERE status='open' AND etapa='pix_enviado' AND store <> 'sandbox'
         AND pix_enviado_em < now() - ($1 || ' minutes')::interval`,
      [ctx.cfg.WA_UPSELL_CLOSE_MIN],
    );
    for (const r of venc.rows) {
      if (r.pix_charge_id && ctx.cfg.PAGARME_SECRET_KEY) {
        await ctx.pagarme.cancelarCharge(r.pix_charge_id).catch(async (e) => {
          await logEvento(ctx, r.store, {
            erro: 'cancel_charge_falhou',
            order_id: r.order_id,
            charge_id: r.pix_charge_id,
            detalhe: String((e as Error).message).slice(0, 200),
          });
        });
      }
      // UPDATE condicionado: se o webhook de pagamento chegou DURANTE esta volta
      // (entre o SELECT e aqui), o 'pago' vence — nunca sobrescrever com 'expirado'
      const fechou = await ctx.db.query(
        `UPDATE wa_upsell SET status='closed', etapa='expirado', atualizado_em=now()
         WHERE store=$1 AND order_id=$2 AND status='open' AND etapa='pix_enviado'
         RETURNING order_id`,
        [r.store, r.order_id],
      );
      // Aviso de expiração: antes o cliente que aceitou e não pagou simplesmente
      // ficava no vácuo. Só sai se ESTA volta foi quem fechou (o RETURNING acima
      // garante: se o pagamento entrou no meio, nada é enviado).
      if (fechou.rows.length) {
        const cfgd = await getDisparosConfig(ctx);
        const oferta = await getOferta(ctx, r.oferta_id);
        const msg = renderCopy(
          oferta?.copies?.msg_pix_expirado ??
            'Poxa, {{nome}}, o código PIX do Ticket Dourado venceu ⏱️\n\nSeu pedido *#{{numero}}* segue confirmado e vai pro faturamento normalmente.\n\nSe ainda quiser o kit, me chama aqui que eu vejo o que dá pra fazer.',
          { nome: primeiroNome(r.customer_name), numero: r.order_number ?? '' },
        );
        if (msg) {
          await ctx.meta.enviarTexto(destino(ctx, cfgd.modo, r.customer_phone), msg).then(
            () => espelhoNota(ctx, r.store, r.order_id, `⏱️ PIX expirou sem pagamento.\n\n🤖 Enviado (WhatsApp): ${msg}`, msg),
            async (e) => {
              await logEvento(ctx, r.store, { erro: 'msg_pix_expirado_falhou', order_id: r.order_id, detalhe: String((e as Error).message).slice(0, 200) });
            },
          );
        }
      }
    }
    // Janela pré-aceite de 25min (alinhada à liberação do pedido no ERP ~28min):
    // fecha aguardando_confirmacao/confirmado/erro_disparo como sem_resposta.
    // Auto-close usa criado_em — re-aberturas resetam. Sandbox fica de fora:
    // os casos do contrato do faturamento são permanentes.
    await ctx.db.query(
      `UPDATE wa_upsell SET status='closed', etapa='sem_resposta', atualizado_em=now()
       WHERE status='open' AND store <> 'sandbox'
         AND etapa IN ('aguardando_confirmacao','confirmado','erro_disparo')
         AND criado_em < now() - ($1 || ' minutes')::interval`,
      [ctx.cfg.WA_UPSELL_JANELA_MIN],
    );
    // corrigir_sac (atendimento humano) tem 4h — e SÓ fecha o cliente que pediu
    // correção e sumiu: correção já coletada (aguardando_aprovacao) segura a row
    // até a decisão do operador.
    await ctx.db.query(
      `UPDATE wa_upsell SET status='closed', etapa='sem_resposta', atualizado_em=now()
       WHERE status='open' AND store <> 'sandbox' AND etapa='corrigir_sac'
         AND criado_em < now() - ($1 || ' hours')::interval
         AND NOT EXISTS (SELECT 1 FROM correcoes c
                         WHERE c.wa_upsell_id = wa_upsell.id AND c.status='aguardando_aprovacao')`,
      [ctx.cfg.WA_UPSELL_AUTO_CLOSE_HORAS],
    );
    // Libera conversa de funil FECHADO sem interação há X min: destrava no
    // TechSAC (volta pro fluxo normal do SAC) e o agente para de responder.
    // liberada_em só marca quando o destravar FUNCIONOU (senão tenta de novo
    // na próxima volta — conversa travada sem dono é cliente preso no limbo).
    if (ctx.chatwoot) {
      const paraLiberar = await ctx.db.query(
        `SELECT c.id, c.chatwoot_conv_interno AS interno, w.store, w.order_id
         FROM conversas c JOIN wa_upsell w ON w.id = c.wa_upsell_id
         WHERE c.liberada_em IS NULL AND c.status='bot' AND w.status='closed'
           AND w.store <> 'sandbox'
           AND c.atualizado_em < now() - ($1 || ' minutes')::interval
         LIMIT 20`,
        [ctx.cfg.WA_UPSELL_LIBERA_CONVERSA_MIN],
      );
      // Conversa devolvida ao SAC há 30+ min e sem correção pendente não é mais
      // trabalho de ninguém aqui: arquiva sozinha (pedido do Jorge 09/08 — a lista
      // principal deve mostrar só o que está de fato aberto). A aba Arquivadas
      // continua dando acesso a tudo.
      await ctx.db.query(
        `UPDATE conversas SET arquivada_em=now()
         WHERE arquivada_em IS NULL AND liberada_em IS NOT NULL
           AND liberada_em < now() - interval '30 minutes'
           AND NOT EXISTS (SELECT 1 FROM correcoes k
                           WHERE k.wa_upsell_id = conversas.wa_upsell_id
                             AND k.status='aguardando_aprovacao')`,
      );
      for (const c of paraLiberar.rows) {
        try {
          // Sem id interno (disparo caiu no fallback pela Meta) não dá pra chamar
          // o destravar — o display_id devolve 404. Solta assim mesmo: o que
          // importa é o agente sair de campo, senão a conversa fica "nossa" pra
          // sempre e a IA responde junto com o atendimento.
          if (c.interno === null) {
            await ctx.db.query('UPDATE conversas SET liberada_em=now(), atualizado_em=now() WHERE id=$1', [c.id]);
            await logEvento(ctx, c.store, {
              evento: 'conversa_liberada_sem_id_interno',
              conversa_id: c.id,
              order_id: c.order_id,
            });
            await espelhoNota(ctx, c.store, c.order_id, '🔓 Agente do upsell saiu da conversa (funil encerrado). Não houve chamada de destravar: o disparo não passou pelo TechSAC e o id interno não existe.');
            continue;
          }
          await ctx.chatwoot.destravarConversa(Number(c.interno));
          await ctx.db.query('UPDATE conversas SET liberada_em=now(), atualizado_em=now() WHERE id=$1', [c.id]);
          await espelhoNota(ctx, c.store, c.order_id, '🔓 Conversa liberada pro fluxo normal do SAC (funil encerrado, sem interação recente). O agente do upsell não responde mais aqui.');
        } catch (e) {
          await logEvento(ctx, c.store, {
            erro: 'liberar_conversa_falhou',
            conversa_id: c.id,
            chatwoot_conv_interno: c.interno,
            detalhe: String((e as Error).message).slice(0, 200),
          });
        }
      }
    }
  } catch {
    /* próxima volta */
  }
}

/* ===== 8. Operações manuais (painel) ===== */

export async function fecharManual(ctx: FunilCtx, store: string, orderId: number, motivo?: string): Promise<void> {
  await ctx.db.query(
    `UPDATE wa_upsell SET status='closed', etapa=COALESCE($3, etapa || '_fechado_manual'), atualizado_em=now()
     WHERE store=$1 AND order_id=$2`,
    [store, orderId, motivo ?? null],
  );
}

export async function forcarExpiracao(ctx: FunilCtx, store: string, orderId: number): Promise<void> {
  await ctx.db.query(
    `UPDATE wa_upsell SET status='closed', etapa='expirado', atualizado_em=now()
     WHERE store=$1 AND order_id=$2 AND etapa='pix_enviado'`,
    [store, orderId],
  );
}

// Disparo manual para um pedido específico (input do order_id no painel).
// Busca o pedido na Yampi, semeia/reabre a row e entra na fila de disparo.
export async function dispararManual(ctx: FunilCtx, store: string, orderId: number): Promise<{ ok: boolean; erro?: string }> {
  let o: any;
  try {
    o = await ctx.yampi.getOrder(orderId);
  } catch (e) {
    return { ok: false, erro: `pedido não encontrado na Yampi: ${String((e as Error).message).slice(0, 200)}` };
  }
  const p = normalizarPedidoYampi(o);
  const oferta = await escolherOferta(ctx, p.valorProdutos);
  if (!oferta) return { ok: false, erro: 'nenhuma oferta ativa para a faixa deste pedido' };
  // 'pago' é estado final: o upsert abaixo o protege, mas sem esta guarda o
  // template sairia mesmo assim, oferecendo algo que o cliente já comprou.
  const jaExiste = await getRow(ctx, store, p.orderId);
  if (jaExiste?.etapa === 'pago') return { ok: false, erro: 'pedido já pagou a oferta' };
  await ctx.db.query(
    `INSERT INTO wa_upsell (store, order_id, order_number, customer_phone, customer_name, customer_cpf, customer_email, status, etapa, oferta_id, disparo_status, valor_produtos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open','aguardando_confirmacao',$8,'fila',$9)
     ON CONFLICT (store, order_id) DO UPDATE SET
       status='open', etapa='aguardando_confirmacao', disparo_status='fila',
       template_msg_id=NULL, oferta_id=EXCLUDED.oferta_id,
       customer_cpf=EXCLUDED.customer_cpf, customer_email=EXCLUDED.customer_email,
       valor_produtos=EXCLUDED.valor_produtos,
       criado_em=now(), atualizado_em=now()
     WHERE wa_upsell.etapa <> 'pago'`, // GOTCHA 20: reset de criado_em; 'pago' é estado final
    [store, p.orderId, p.numero, p.fone, p.nome, p.cpf || null, p.email, oferta.id, p.valorProdutos],
  );
  await ctx.db.query(
    `INSERT INTO pedidos_status (store, order_id, status, payload, atualizado_em)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (store, order_id) DO UPDATE SET status=EXCLUDED.status, payload=EXCLUDED.payload, atualizado_em=now()`,
    [store, p.orderId, p.status, o],
  );
  // Disparo manual NÃO passa pela fila: é decisão humana explícita, um pedido
  // por vez. Pela fila ele ficaria preso enquanto o kill switch estivesse
  // ligado — e é justamente com o automático pausado que se faz teste dirigido
  // (ex.: escolher 5 clientes na mão). Também dá retorno imediato no painel.
  const row = await getRow(ctx, store, p.orderId);
  if (!row) return { ok: false, erro: 'row não encontrada após semear' };
  await dispararTemplate(ctx, row);
  const depois = await getRow(ctx, store, p.orderId);
  if (depois?.disparo_status === 'erro') {
    return { ok: false, erro: 'falha no envio — ver aba Logs' };
  }
  return { ok: true };
}
