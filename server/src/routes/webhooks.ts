// Webhooks de entrada. Token fraco na URL (?t=, sha256 derivado do BACKEND_TOKEN)
// para Yampi/Pagar.me; Meta usa hub.challenge + X-Hub-Signature-256.
// SEMPRE responder 200 rápido: processamento pesado não pode derrubar o webhook.
import type { FastifyInstance } from 'fastify';
import type { AgenteCtx } from '../domain/agente/agente.js';
import { FILA_META, confirmarPagamento, logEvento, processarPedidoYampi } from '../domain/funil.js';
import { processarWebhookMeta } from '../domain/metaWebhook.js';

export function webhookRoutes(app: FastifyInstance, ctx: AgenteCtx): void {
  const cfg = ctx.cfg;

  // ===== Yampi: eventos order.* =====
  app.post('/webhook/yampi', async (req, reply) => {
    if ((req.query as any).t !== cfg.webhookTokenYampi) return reply.code(403).send({ error: 'forbidden' });
    const body = (req.body ?? {}) as any;
    const evento = String(body.event ?? 'desconhecido');
    await logEvento(ctx, 'hidrabene', { origem: 'yampi', evento, payload: body });
    try {
      const o = body.resource?.data ?? body.resource ?? body.data ?? body.order ?? null;
      if (o && o.id && evento.startsWith('order.')) {
        await processarPedidoYampi(ctx, 'hidrabene', o);
      }
    } catch (e) {
      await logEvento(ctx, 'hidrabene', { erro: 'webhook_yampi_falhou', detalhe: String((e as Error).message).slice(0, 300) });
    }
    return { received: true };
  });

  // ===== Pagar.me: eventos de pagamento =====
  app.post('/webhook/pagarme', async (req, reply) => {
    if ((req.query as any).t !== cfg.webhookTokenPagarme) return reply.code(403).send({ error: 'forbidden' });
    const body = (req.body ?? {}) as any;
    await logEvento(ctx, 'pagarme', body);
    const tipo = String(body.type ?? body.event ?? '');
    // charge.paid / order.paid confirmam; eventos de falha/estorno NÃO
    if (/paid|payment/.test(tipo) && !/fail|refus|refund|cancel|chargeback/.test(tipo)) {
      await confirmarPagamento(ctx, body).catch(async (e) => {
        await logEvento(ctx, 'pagarme', { erro: 'confirmar_pagamento_falhou', detalhe: String((e as Error).message).slice(0, 300) });
      });
    }
    return { received: true };
  });

  // (Sem webhook do Chatwoot: a Meta chama direto e o agente IA é acionado
  //  dentro do processarWebhookMeta — decisão do Jorge, 08/08/2026.)

  // ===== Meta: verificação + nfm_reply dos flows (+ status de entrega) =====
  app.get('/webhook/meta', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.verify_token'] === cfg.METAWA_VERIFY_TOKEN && cfg.METAWA_VERIFY_TOKEN) {
      return reply.code(200).send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send();
  });

  app.post('/webhook/meta', async (req, reply) => {
    // A Meta chama DIRETO (decisão do Jorge, sem n8n): com META_APP_SECRET
    // configurado, payload sem assinatura válida é recusado.
    const rawBody = (req as any).rawBody ?? '';
    if (!ctx.meta.validarAssinatura(rawBody, req.headers['x-hub-signature-256'] as string | undefined)) {
      return reply.code(403).send({ error: 'assinatura inválida' });
    }
    const body = (req.body ?? {}) as any;
    // Debug de distribuição (ligar com WAUP_DEBUG_META=1): resume o que chega
    // sem violar a limpeza — só campo/tipos/remetentes, nunca o conteúdo.
    if (ctx.cfg.WAUP_DEBUG_META === '1') {
      const resumo = (body.entry ?? []).flatMap((e: any) => (e.changes ?? []).map((ch: any) => ({
        field: ch.field,
        msgs: (ch.value?.messages ?? []).map((m: any) => `${m.type}:${String(m.from ?? '').slice(-4)}`),
        statuses: (ch.value?.statuses ?? []).map((s: any) => s.status),
      })));
      await logEvento(ctx, 'hidrabene', { debug: 'meta_in', resumo });
    }
    // Fila (Redis): responde à Meta em ms; o worker do sweeper processa (agente
    // IA leva segundos — processar inline estoura o timeout do webhook da Meta).
    try {
      await ctx.redis.rpush(FILA_META, rawBody || JSON.stringify(body));
    } catch (e) {
      // Redis fora: processa inline (melhor lento que perder mensagem)
      await processarWebhookMeta(ctx, body).catch(async (e2) => {
        await logEvento(ctx, 'hidrabene', { erro: 'webhook_meta_falhou', detalhe: String((e2 as Error).message).slice(0, 300) });
      });
    }
    return { received: true };
  });
}
