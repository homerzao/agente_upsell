// Webhooks de entrada. Token fraco na URL (?t=, sha256 derivado do BACKEND_TOKEN)
// para Yampi/Pagar.me; Meta usa hub.challenge + X-Hub-Signature-256.
// SEMPRE responder 200 rápido: processamento pesado não pode derrubar o webhook.
import type { FastifyInstance } from 'fastify';
import type { AgenteCtx } from '../domain/agente/agente.js';
import { processarMensagemCliente } from '../domain/agente/agente.js';
import { FILA_META, confirmarPagamento, getDisparosConfig, logEvento, processarPedidoYampi } from '../domain/funil.js';
import { confirmarWamid, liberarWamid, processarWebhookMeta, reivindicarWamid } from '../domain/metaWebhook.js';
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
    // charge.paid / order.paid confirmam; eventos de falha/estorno NÃO
    if (/paid|payment/.test(tipo) && !/fail|refus|refund|cancel|chargeback/.test(tipo)) {
      await confirmarPagamento(ctx, body).catch(async (e) => {
        await logEvento(ctx, 'pagarme', { erro: 'confirmar_pagamento_falhou', detalhe: String((e as Error).message).slice(0, 300) });
      });
    }
    return { received: true };
  });

  // ===== Chatwoot (TechSAC): fonte de INBOUND de cliente =====
  // RESTAURADO 09/08: a Meta entrega inbound de cliente SÓ pro app do chat
  // (o nosso app Wpp Flow recebe apenas statuses — evidência: 641 webhooks/70min,
  // zero texto). O TechSAC recebe tudo na hora → o message_created dele vira
  // nossa fonte. Dedup UNIFICADO com o caminho da Meta: ambos disputam o claim
  // do mesmo wamid (source_id do Chatwoot = wamid) — se a Meta voltar a entregar
  // inbound pra gente, nunca processa 2x.
  app.post('/webhook/chatwoot', async (req, reply) => {
    if ((req.query as any).t !== cfg.webhookTokenChatwoot) return reply.code(403).send({ error: 'forbidden' });
    const body = (req.body ?? {}) as any;
    if (String(body.event ?? '') !== 'message_created') return { received: true };
    if (body.message_type !== 'incoming' && body.message_type !== 0) return { received: true };
    if (body.private) return { received: true };
    const inboxId = body.inbox?.id ?? body.conversation?.inbox_id;
    if (cfg.CHATWOOT_INBOX_ID && String(inboxId) !== String(cfg.CHATWOOT_INBOX_ID)) return { received: true };
    const conversationId = Number(body.conversation?.id);
    const texto = String(body.content ?? '').trim();
    const fone = soDigitos(body.sender?.phone_number ?? body.conversation?.meta?.sender?.phone_number ?? '');
    if (!conversationId || !texto || !fone) return { received: true };
    // claim compartilhado com o webhook da Meta (mesma chave waup:wamid:<id>)
    const wamid = String(body.source_id ?? '').replace(/^waup-wa:/, '');
    if (wamid && !(await reivindicarWamid(ctx, wamid))) return { received: true };
    // responde já; o processamento (agente IA) segue async
    processarMensagemCliente(ctx, conversationId, fone, texto)
      .then(() => confirmarWamid(ctx, wamid))
      .catch(async (e) => {
        await liberarWamid(ctx, wamid);
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
    // A Meta chama DIRETO (decisão do Jorge, sem n8n): com META_APP_SECRET
    // configurado, payload sem assinatura válida é recusado.
    const rawBody = (req as any).rawBody ?? '';
    const assinatura = req.headers['x-hub-signature-256'] as string | undefined;
    // Contingência de roteador (n8n): com ?t=<token> válido na URL, aceita sem
    // assinatura — o forward não repassa os headers da Meta. Sem token, a
    // assinatura continua obrigatória.
    const tokenOk = (req.query as any).t === cfg.webhookTokenMeta;
    if (!tokenOk && !ctx.meta.validarAssinatura(rawBody, assinatura)) {
      await logEvento(ctx, 'hidrabene', {
        erro: 'meta_assinatura_invalida',
        detalhe: assinatura ? 'header presente mas não confere (app secret errado?)' : 'sem header x-hub-signature-256',
      });
      return reply.code(403).send({ error: 'assinatura inválida' });
    }
    const body = (req.body ?? {}) as any;
    // Debug de distribuição (toggle na aba Logs do painel, ou WAUP_DEBUG_META=1):
    // resume o que chega — só campo/tipos/remetentes, nunca o conteúdo.
    const cfgd = await getDisparosConfig(ctx).catch(() => null);
    if (cfgd?.debug_meta || ctx.cfg.WAUP_DEBUG_META === '1') {
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
