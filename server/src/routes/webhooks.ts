// Webhooks de entrada. Token fraco na URL (?t=, sha256 derivado do BACKEND_TOKEN)
// para Yampi/Pagar.me/Chatwoot; Meta usa hub.challenge + X-Hub-Signature-256.
// SEMPRE responder 200 rápido: processamento pesado não pode derrubar o webhook.
import type { FastifyInstance } from 'fastify';
import type { AgenteCtx } from '../domain/agente/agente.js';
import { processarMensagemCliente } from '../domain/agente/agente.js';
import { confirmarPagamento, logEvento, processarPedidoYampi, registrarResposta } from '../domain/funil.js';
import { parseFlowToken } from '../domain/estados.js';
import { soDigitos } from '../lib/util.js';

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
    if (/paid|payment/.test(tipo)) {
      await confirmarPagamento(ctx, body).catch(async (e) => {
        await logEvento(ctx, 'pagarme', { erro: 'confirmar_pagamento_falhou', detalhe: String((e as Error).message).slice(0, 300) });
      });
    }
    return { received: true };
  });

  // ===== Chatwoot: message_created (conversa do agente IA) =====
  app.post('/webhook/chatwoot', async (req, reply) => {
    if ((req.query as any).t !== cfg.webhookTokenChatwoot) return reply.code(403).send({ error: 'forbidden' });
    const body = (req.body ?? {}) as any;
    const evento = String(body.event ?? '');
    // Filtra: só mensagem de cliente (incoming), da inbox certa, não-privada.
    // Mensagens do próprio bot voltam como outgoing — ignoradas aqui.
    if (evento !== 'message_created') return { received: true };
    if (body.message_type !== 'incoming' && body.message_type !== 0) return { received: true };
    if (body.private) return { received: true };
    const inboxId = body.inbox?.id ?? body.conversation?.inbox_id;
    if (cfg.CHATWOOT_INBOX_ID && String(inboxId) !== String(cfg.CHATWOOT_INBOX_ID)) return { received: true };
    const conversationId = body.conversation?.id;
    const texto = String(body.content ?? '').trim();
    const fone = soDigitos(body.sender?.phone_number ?? body.conversation?.meta?.sender?.phone_number ?? '');
    if (!conversationId || !texto) return { received: true };
    // Processa async: webhook responde já (Chatwoot não espera o modelo)
    processarMensagemCliente(ctx, Number(conversationId), fone, texto).catch(async (e) => {
      await logEvento(ctx, 'hidrabene', { erro: 'webhook_chatwoot_falhou', detalhe: String((e as Error).message).slice(0, 300) });
    });
    return { received: true };
  });

  // ===== Meta: verificação + nfm_reply dos flows (+ status de entrega) =====
  app.get('/webhook/meta', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.verify_token'] === cfg.METAWA_VERIFY_TOKEN && cfg.METAWA_VERIFY_TOKEN) {
      return reply.code(200).send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send();
  });

  app.post('/webhook/meta', async (req, reply) => {
    // Assinatura (quando META_APP_SECRET configurado). O n8n do Jorge pode
    // forwardar sem assinatura — nesse caso, deixar META_APP_SECRET vazio.
    const rawBody = (req as any).rawBody ?? '';
    if (!ctx.meta.validarAssinatura(rawBody, req.headers['x-hub-signature-256'] as string | undefined)) {
      return reply.code(403).send({ error: 'assinatura inválida' });
    }
    const body = (req.body ?? {}) as any;
    await logEvento(ctx, 'hidrabene', { origem: 'meta', payload: body });
    try {
      // Formato direto (n8n forwarda só o nfm_reply): {flow_token, ...respostas}
      if (body.flow_token && !body.entry) {
        const ref = parseFlowToken(body.flow_token);
        if (ref) await registrarResposta(ctx, ref.store, ref.orderId, body);
        return { received: true };
      }
      for (const entry of body.entry ?? []) {
        for (const ch of entry.changes ?? []) {
          // Respostas de Flow: flow_token = "loja:order_id"; response_json tem a decisão
          for (const msg of ch.value?.messages ?? []) {
            const nfm = msg.interactive?.nfm_reply;
            if (!nfm) continue;
            let resp: any = {};
            try {
              resp = JSON.parse(nfm.response_json ?? '{}');
            } catch {
              continue;
            }
            const ref = parseFlowToken(resp.flow_token);
            if (ref) await registrarResposta(ctx, ref.store, ref.orderId, resp);
          }
          // Status de entrega do template (card "entregues" do painel)
          for (const st of ch.value?.statuses ?? []) {
            if (['delivered', 'read'].includes(String(st.status)) && st.id) {
              await ctx.db.query(
                `UPDATE wa_upsell SET disparo_status='entregue', atualizado_em=now()
                 WHERE template_msg_id=$1 AND disparo_status='enviado'`,
                [st.id],
              );
            }
          }
        }
      }
    } catch (e) {
      // wa_events guarda o raw pra diagnóstico
      await logEvento(ctx, 'hidrabene', { erro: 'webhook_meta_falhou', detalhe: String((e as Error).message).slice(0, 300) });
    }
    return { received: true };
  });
}
