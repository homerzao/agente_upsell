// Data channel do flow v6 (POST /flow/upsell): quando o cliente toca
// "Confirmar Pedido", a META chama aqui pra decidir se mostra o TICKET
// (dentro da janela) ou pula pro CONFIRMADO com oferta_resultado='expirada'.
// Sem este endpoint o flow v6/v7 nem publica (a Meta valida o ping).
import type { FastifyInstance } from 'fastify';
import {
  decryptFlowRequest, encryptFlowResponse, type FlowPayload, type FlowRequestBody,
} from '../services/flowCrypto.js';
import { parseFlowToken } from '../domain/estados.js';
import { getRow, logEvento, waupSet, type FunilCtx } from '../domain/funil.js';

// Decide a resposta do data_exchange — separado pra teste.
export async function decidirDataExchange(ctx: FunilCtx, payload: FlowPayload): Promise<Record<string, unknown>> {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const fallbackExpirada = {
    screen: 'CONFIRMADO',
    data: { saudacao_ok: data.saudacao_ok ?? '', oferta_resultado: 'expirada' },
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
  // carimba a abertura do flow (mede leitura -> abertura no dashboard)
  await waupSet(ctx, ref.store, ref.orderId, { etapa: 'confirmado', abriu_flow_em: new Date().toISOString() });
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
