// Data channel do flow v6 (POST /flow/upsell): quando o cliente toca
// "Confirmar Pedido", a META chama aqui pra decidir se mostra o TICKET
// (dentro da janela) ou pula pro CONFIRMADO com oferta_resultado='expirada'.
// Sem este endpoint o flow v6/v7 nem publica (a Meta valida o ping).
import type { FastifyInstance } from 'fastify';
import {
  decryptFlowRequest, encryptFlowResponse, type FlowPayload, type FlowRequestBody,
} from '../services/flowCrypto.js';
import { parseFlowToken } from '../domain/estados.js';
import { getOferta, getRow, logEvento, waupSet, type FunilCtx } from '../domain/funil.js';
import { COPIES_DEFAULT } from '../domain/copies.js';
import { primeiroNome, renderCopy } from '../lib/util.js';

// Textos da oferta da row, renderizados — v8: a tela do TICKET é 100% dinâmica
// (multi-oferta usa o MESMO flow), e a CONFIRMA resume o que a pessoa leva.
async function dadosOfertaV8(ctx: FunilCtx, row: NonNullable<Awaited<ReturnType<typeof getRow>>>) {
  const oferta = await getOferta(ctx, row.oferta_id);
  const copies = { ...COPIES_DEFAULT, ...(oferta?.copies ?? {}) };
  const brl = (n: number) => n.toFixed(2).replace('.', ',');
  // Economia calculada aqui (preco_de − preco, % real arredondada — mesma conta
  // do badge da vitrine): copy de oferta nova nasce com os números certos.
  const temDe = oferta?.preco_de != null && oferta.preco_de > (oferta?.preco ?? 0);
  const vars = {
    nome: primeiroNome(row.customer_name),
    numero: String(row.order_number ?? ''),
    produto: oferta?.nome ?? '',
    preco: oferta ? brl(oferta.preco) : '',
    preco_de: temDe ? brl(oferta!.preco_de!) : '',
    economia: temDe ? brl(oferta!.preco_de! - oferta!.preco) : '',
    desconto_pct: temDe ? String(Math.round((1 - oferta!.preco / oferta!.preco_de!) * 100)) : '',
  };
  const r = (chave: string) => renderCopy(copies[chave] ?? '', vars);
  return {
    titulo_ticket: r('flow_titulo_ticket'),
    confirma_titulo: r('flow_confirma_titulo'),
    oferta_urgencia: r('flow_oferta_urgencia'),
    oferta_intro: r('flow_oferta_intro'),
    oferta_bullets: r('flow_oferta_bullets'),
    oferta_extras: r('flow_oferta_extras'),
    oferta_preco_linha: r('flow_oferta_preco_linha'),
    oferta_prazo_linha: r('flow_oferta_prazo_linha'),
    confirma_resumo: r('flow_confirma_resumo'),
  };
}

// Decide a resposta do data_exchange — separado pra teste.
export async function decidirDataExchange(ctx: FunilCtx, payload: FlowPayload): Promise<Record<string, unknown>> {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  // fv: versão do flow que está chamando. O v7 (sem fv) espera EXATAMENTE os
  // campos antigos — devolver chave extra quebra a validação de schema da Meta.
  const v8 = String(data.fv ?? '') === '8';
  // v8: CONFIRMADO declara `origem` (metrificação de onde a pessoa saiu);
  // v7 NÃO — mandar chave extra pro flow antigo quebra o schema da Meta.
  const fallbackExpirada = {
    screen: 'CONFIRMADO',
    data: {
      saudacao_ok: data.saudacao_ok ?? '',
      oferta_resultado: 'expirada',
      ...(v8 ? { origem: 'expirada' } : {}),
    },
  };
  const ref = parseFlowToken(payload.flow_token);
  if (!ref) return fallbackExpirada;
  const row = await getRow(ctx, ref.store, ref.orderId);
  const dentroDaJanela =
    row && row.status === 'open' && ['aguardando_confirmacao', 'confirmado'].includes(row.etapa);
  if (!dentroDaJanela) {
    await logEvento(ctx, ref.store, {
      evento: 'ticket_ocultado_fora_da_janela',
      order_id: ref.orderId,
      etapa: row?.etapa ?? 'inexistente',
    });
    return fallbackExpirada;
  }

  // v8, etapa 2: tocou "QUERO" no TICKET → double-check. Ainda NÃO é aceite —
  // o aceite (e o PIX) só acontecem no botão "GERAR CÓDIGO PIX" da tela
  // seguinte (o "Sair sem a oferta" registra recusa). Sem radio: feedback do
  // Jorge no preview — botão dourado + link de saída na MESMA tela, igual à
  // receita da tela do ticket. Este round-trip também é a MÉTRICA do clique
  // acidental: quem chega aqui e não confirma era quem gerava PIX à toa.
  if (v8 && data.acao === 'quero') {
    await logEvento(ctx, ref.store, { evento: 'ticket_quero', order_id: ref.orderId });
    const d = await dadosOfertaV8(ctx, row);
    return {
      screen: 'CONFIRMA',
      data: {
        confirma_titulo: d.confirma_titulo,
        confirma_resumo: d.confirma_resumo,
        saudacao_ok: data.saudacao_ok ?? '',
      },
    };
  }

  // carimba a abertura do flow (mede leitura -> abertura no dashboard)
  await waupSet(ctx, ref.store, ref.orderId, { etapa: 'confirmado', abriu_flow_em: new Date().toISOString() });
  if (v8) {
    const d = await dadosOfertaV8(ctx, row);
    return {
      screen: 'TICKET',
      data: {
        titulo_ticket: d.titulo_ticket,
        oferta_urgencia: d.oferta_urgencia,
        oferta_intro: d.oferta_intro,
        oferta_bullets: d.oferta_bullets,
        oferta_extras: d.oferta_extras,
        oferta_preco_linha: d.oferta_preco_linha,
        oferta_prazo_linha: d.oferta_prazo_linha,
        saudacao_ok: data.saudacao_ok ?? '',
      },
    };
  }
  return {
    screen: 'TICKET',
    data: { titulo_ticket: data.titulo_ticket ?? '', saudacao_ok: data.saudacao_ok ?? '' },
  };
}

// Processa um request da Meta; retorna status HTTP + body (base64 cru ou vazio).
export async function tratarFlowRequest(
  ctx: FunilCtx,
  body: FlowRequestBody,
): Promise<{ status: number; body: string }> {
  if (!ctx.cfg.FLOW_PRIVATE_KEY) {
    await logEvento(ctx, 'hidrabene', { erro: 'flow_sem_chave_privada' });
    return { status: 421, body: '' };
  }
  let aesKey: Buffer, iv: Buffer, payload: FlowPayload;
  try {
    // env pode vir com \n escapado (uma linha)
    const pem = ctx.cfg.FLOW_PRIVATE_KEY.replace(/\\n/g, '\n');
    ({ aesKey, iv, payload } = decryptFlowRequest(pem, body));
  } catch {
    // não-decriptável: 421 — a Meta reenta com esse código
    return { status: 421, body: '' };
  }
  try {
    if (payload.action === 'ping') {
      return { status: 200, body: encryptFlowResponse(aesKey, iv, { data: { status: 'active' } }) };
    }
    if (payload.action === 'data_exchange') {
      const resposta = await decidirDataExchange(ctx, payload);
      return { status: 200, body: encryptFlowResponse(aesKey, iv, resposta) };
    }
    await logEvento(ctx, 'hidrabene', { erro: 'flow_action_desconhecida', action: payload.action });
    return { status: 421, body: '' };
  } catch (e) {
    await logEvento(ctx, 'hidrabene', { erro: 'flow_data_exchange_falhou', detalhe: String((e as Error).message).slice(0, 300) });
    return { status: 421, body: '' };
  }
}

export function flowRoutes(app: FastifyInstance, ctx: FunilCtx): void {
  app.post('/flow/upsell', async (req, reply) => {
    const r = await tratarFlowRequest(ctx, (req.body ?? {}) as FlowRequestBody);
    // resposta é base64 PURO no body (sem JSON em volta)
    return reply.code(r.status).type('text/plain').send(r.body);
  });
}
