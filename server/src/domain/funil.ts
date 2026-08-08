// Orquestrador do funil de upsell — porte 1:1 da lógica VALIDADA do agente_ecom,
// com disparo controlado (piloto/amostra/rate/kill switch) e Chatwoot.
// Todas as dependências entram via ctx (testável com fakes).
import type { Db } from '../db/pool.js';
import type { Config } from '../config.js';
import type { MetaService } from '../services/meta.js';
import type { YampiService } from '../services/yampi.js';
import type { PagarmeService } from '../services/pagarme.js';
import type { ChatwootService } from '../services/chatwoot.js';
import { LABEL_UPSELL } from '../services/chatwoot.js';
import { carbon, foneBr, primeiroNome, renderCopy, soDigitos, valorBr } from '../lib/util.js';
import { decidirDisparo, destinoMensagem, ehTransicaoParaPago, interpretarRespostaFlow } from './estados.js';
import { montarTemplateConfirma } from './template.js';
import type { DisparosConfig, Oferta, RespostaFlow, WaUpsellRow } from './tipos.js';

export const FILA_DISPARO = 'waup:fila_disparo';

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

// Dados normalizados de um pedido Yampi (webhook ou GET) — puro, coberto por teste.
export function normalizarPedidoYampi(o: any): {
  orderId: number;
  numero: string;
  status: string | null;
  nome: string | null;
  fone: string;
  cpf: string;
  email: string | null;
  endereco: string;
  customerId: number | null;
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
  return {
    orderId: Number(o.id),
    numero: String(o.number ?? ''),
    status,
    nome: cust.name ?? ([cust.first_name, cust.last_name].filter(Boolean).join(' ') || null),
    fone: foneBr(cust.phone?.full_number ?? cust.phone ?? ''),
    cpf: soDigitos(cust.cpf ?? cust.document ?? ''),
    email: cust.email ?? null,
    endereco,
    customerId: cust.id ?? null,
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
  const oferta = await getOferta(ctx);
  const decisao = decidirDisparo(cfgd, p.cpf, Boolean(oferta));
  // Registra TODO pedido pago (mesmo fora do filtro) — o faturamento consulta
  // qualquer pedido e sempre recebe resposta (closed/fora_do_fluxo).
  const ins = await ctx.db.query(
    `INSERT INTO wa_upsell (store, order_id, order_number, customer_phone, customer_name, customer_cpf, customer_email, status, etapa, oferta_id, disparo_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (store, order_id) DO NOTHING RETURNING order_id`,
    [
      store, p.orderId, p.numero, p.fone, p.nome, p.cpf || null, p.email,
      decisao.elegivel ? 'open' : 'closed',
      decisao.elegivel ? 'aguardando_confirmacao' : 'fora_do_fluxo',
      oferta?.id ?? null,
      decisao.elegivel ? 'fila' : null,
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
  const oferta = await getOferta(ctx, row.oferta_id);
  const copies = oferta?.copies ?? {};
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
    const r = await ctx.meta.waSendRaw(payload);
    await waupSet(ctx, row.store, row.order_id, {
      template_msg_id: r.messages?.[0]?.id ?? null,
      disparo_status: 'enviado',
    });
    await criarConversaChatwoot(ctx, row, cfgd.modo).then(
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
export async function criarConversaChatwoot(ctx: FunilCtx, row: WaUpsellRow, modo: 'test' | 'live'): Promise<number | null> {
  if (!ctx.chatwoot) return null;
  const fone = destino(ctx, modo, row.customer_phone);
  let contato = await ctx.chatwoot.buscarContatoPorFone(fone);
  if (!contato) contato = await ctx.chatwoot.criarContato(row.customer_name ?? 'Cliente Hidrabene', fone);
  const conv = await ctx.chatwoot.buscarOuCriarConversa(contato.id);
  const convId = conv.id ?? conv.payload?.id;
  if (!convId) throw new Error('conversa chatwoot sem id');
  await ctx.chatwoot.setLabels(convId, [LABEL_UPSELL]).catch(() => {});
  if (ctx.cfg.CHATWOOT_AGENT_ID) {
    await ctx.chatwoot.atribuirAgente(convId, Number(ctx.cfg.CHATWOOT_AGENT_ID)).catch(() => {});
  }
  await ctx.db.query(
    `INSERT INTO conversas (wa_upsell_id, chatwoot_conversation_id, chatwoot_contact_id, status)
     VALUES ($1,$2,$3,'bot')
     ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET wa_upsell_id=EXCLUDED.wa_upsell_id, atualizado_em=now()`,
    [row.id, convId, contato.id],
  );
  return Number(convId);
}

// Row do funil em CONTEXTO ATIVO pro fone: open, ou fechada há < 24h (pós-msg).
// fora_do_fluxo nunca conta — é SAC comum, não é conversa nossa.
// Espelho pro SAC: replica como NOTA INTERNA no Chatwoot o que saiu DIRETO pela
// Meta — atendente que abrir a conversa vê o funil inteiro (pedido do Jorge,
// 08/08/2026: "preciso que seja replicado como msg interna no chatwoot").
// Best-effort: falha do espelho NUNCA derruba o funil.
export async function espelhoNota(ctx: FunilCtx, store: string, orderId: number, texto: string): Promise<void> {
  if (!ctx.chatwoot) return;
  try {
    const r = await ctx.db.query(
      `SELECT c.chatwoot_conversation_id AS cid FROM conversas c
       JOIN wa_upsell w ON w.id = c.wa_upsell_id
       WHERE w.store=$1 AND w.order_id=$2 ORDER BY c.id DESC LIMIT 1`,
      [store, orderId],
    );
    const cid = r.rows[0]?.cid;
    if (cid) await ctx.chatwoot.enviarMensagem(Number(cid), texto, true);
  } catch {
    /* espelho é só contexto */
  }
}

export async function buscarRowContextoAtivo(ctx: FunilCtx, fone: string): Promise<WaUpsellRow | null> {
  const dig = foneBr(fone);
  if (!dig) return null;
  // Fallback pelos últimos 11 dígitos (DDD+9+número): cobre row legada gravada
  // sem DDI e o caso da Meta mandar o número sem o nono dígito.
  const r = await ctx.db.query(
    `SELECT * FROM wa_upsell
     WHERE (customer_phone = $1 OR right($1, 11) = right(customer_phone, 11)) AND store='hidrabene'
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
    () => espelhoNota(ctx, row.store, row.order_id, `🤖 Enviado (WhatsApp): ${msg}`),
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
          () => espelhoNota(ctx, store, orderId, `🤖 Enviado (WhatsApp): ${msg}\n\n✏️ Cliente pediu CORREÇÃO de dados — conversa segue com o agente/atendimento.`),
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
      await waupSet(ctx, store, orderId, { etapa: 'confirmado' });
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
          () => espelhoNota(ctx, store, orderId, `🤖 Enviado (WhatsApp): ${msg}\n\n⏰ Cliente tentou aceitar a oferta FORA da janela.`),
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
    minutos: ctx.cfg.WA_UPSELL_PIX_TTL_MIN,
  });
  await ctx.meta.enviarTexto(fone, msgAceite).then(
    () => espelhoNota(ctx, store, orderId, `🏆 Cliente ACEITOU a oferta.\n\n🤖 Enviado (WhatsApp): ${msgAceite}`),
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
    pix_charge_id: pix.chargeId,
    pix_codigo: pix.codigo,
    pix_enviado_em: new Date().toISOString(),
    pix_expira_em: new Date(Date.now() + ctx.cfg.WA_UPSELL_PIX_TTL_MIN * 60 * 1000).toISOString(),
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
    await espelhoNota(ctx, store, orderId, `🤖 Enviado (WhatsApp): código PIX copia-e-cola da oferta — R$ ${valorBr(oferta.preco)}, vale ${ctx.cfg.WA_UPSELL_PIX_TTL_MIN} min (charge ${pix.chargeId ?? '?'}).`);
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
  const cfgd = await getDisparosConfig(ctx);
  // PIX ainda vivo: reenvia o MESMO código (idempotente — nunca cobrar 2×)
  if (row.etapa === 'pix_enviado' && row.pix_codigo && row.pix_expira_em && new Date(row.pix_expira_em) > new Date()) {
    await ctx.meta.enviarTexto(destino(ctx, cfgd.modo, row.customer_phone), row.pix_codigo).then(
      () => espelhoNota(ctx, store, orderId, '🤖 Reenviado (WhatsApp): mesmo código PIX (ainda válido).'),
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
  if (depois?.etapa === 'pix_enviado' && depois.pix_codigo) return { ok: true };
  return { ok: false, motivo: 'falha_ao_gerar_pix' };
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
        `💰 OFERTA PAGA — R$ ${valorBr(valor)} via PIX (charge ${chargeId}). Faturamento adiciona o SKU ${oferta?.sku_yampi ?? '?'} ao pedido.\n\n🤖 Enviado (WhatsApp): ${msgPago}`),
      async (e) => {
        await logEvento(ctx, row.store, { erro: 'confirmacao_pago_falhou', order_id: row.order_id, detalhe: String((e as Error).message).slice(0, 300) });
      },
    );
  return true;
}

/* ===== 7. Sweeper (por minuto) ===== */

export async function sweep(ctx: FunilCtx): Promise<void> {
  try {
    // PIX vencido: fecha expirado. Cancelamento na Pagar.me é best-effort —
    // GOTCHA 11: charge pending responde 412 (esperado); o QR morre sozinho.
    const venc = await ctx.db.query(
      `SELECT store, order_id, pix_charge_id FROM wa_upsell
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
      await ctx.db.query(
        `UPDATE wa_upsell SET status='closed', etapa='expirado', atualizado_em=now()
         WHERE store=$1 AND order_id=$2 AND status='open' AND etapa='pix_enviado'`,
        [r.store, r.order_id],
      );
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
  const oferta = await getOferta(ctx);
  if (!oferta) return { ok: false, erro: 'nenhuma oferta ativa' };
  await ctx.db.query(
    `INSERT INTO wa_upsell (store, order_id, order_number, customer_phone, customer_name, customer_cpf, customer_email, status, etapa, oferta_id, disparo_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open','aguardando_confirmacao',$8,'fila')
     ON CONFLICT (store, order_id) DO UPDATE SET
       status='open', etapa='aguardando_confirmacao', disparo_status='fila',
       template_msg_id=NULL, oferta_id=EXCLUDED.oferta_id,
       customer_cpf=EXCLUDED.customer_cpf, customer_email=EXCLUDED.customer_email,
       criado_em=now(), atualizado_em=now()
     WHERE wa_upsell.etapa <> 'pago'`, // GOTCHA 20: reset de criado_em; 'pago' é estado final
    [store, p.orderId, p.numero, p.fone, p.nome, p.cpf || null, p.email, oferta.id],
  );
  await ctx.db.query(
    `INSERT INTO pedidos_status (store, order_id, status, payload, atualizado_em)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (store, order_id) DO UPDATE SET status=EXCLUDED.status, payload=EXCLUDED.payload, atualizado_em=now()`,
    [store, p.orderId, p.status, o],
  );
  await ctx.redis.rpush(FILA_DISPARO, JSON.stringify({ store, order_id: p.orderId }));
  return { ok: true };
}
