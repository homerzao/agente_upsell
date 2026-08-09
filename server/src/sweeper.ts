// Jobs periódicos:
// - a cada 60s: expira PIX vencido (10min), fecha sem_resposta (25min) e corrigir_sac (4h)
// - a cada 5s: drena a fila de disparo respeitando kill switch e rate/hora
// - a cada 1s: drena a fila de webhooks da Meta (o handler só enfileira — o
//   processamento inclui o agente IA, que leva segundos)
// - a cada 6h: retenção de wa_events (30 dias; eventos de pagamento ficam)
import type { AgenteCtx } from './domain/agente/agente.js';
import { responderPendentes } from './domain/agente/agente.js';
import { FILA_META, logEvento, processarFilaDisparo, sweep } from './domain/funil.js';
import { processarWebhookMeta } from './domain/metaWebhook.js';

export function startSweeper(ctx: AgenteCtx): () => void {
  let rodandoSweep = false;
  let rodandoFila = false;
  let rodandoMeta = false;

  const t1 = setInterval(async () => {
    if (rodandoSweep) return; // não sobrepõe voltas lentas
    rodandoSweep = true;
    try {
      await sweep(ctx);
    } finally {
      rodandoSweep = false;
    }
  }, 60_000);

  const t2 = setInterval(async () => {
    if (rodandoFila) return;
    rodandoFila = true;
    try {
      await processarFilaDisparo(ctx);
    } catch {
      /* próxima volta */
    } finally {
      rodandoFila = false;
    }
  }, 5_000);

  // Debounce das mensagens do cliente: responde quando ele para de digitar
  let rodandoPendentes = false;
  const t5 = setInterval(async () => {
    if (rodandoPendentes) return;
    rodandoPendentes = true;
    try {
      await responderPendentes(ctx);
    } catch {
      /* próxima volta */
    } finally {
      rodandoPendentes = false;
    }
  }, 5_000);

  // Fila da Meta: FIFO, um payload por vez (ordem importa pro funil)
  const t4 = setInterval(async () => {
    if (rodandoMeta) return;
    rodandoMeta = true;
    try {
      for (;;) {
        const raw = await ctx.redis.lpop(FILA_META);
        if (!raw) break;
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          continue;
        }
        await processarWebhookMeta(ctx, body).catch(async (e) => {
          await logEvento(ctx, 'hidrabene', { erro: 'fila_meta_falhou', detalhe: String((e as Error).message).slice(0, 300) });
        });
      }
    } catch {
      /* próxima volta */
    } finally {
      rodandoMeta = false;
    }
  }, 1_000);

  // Limpeza: requisito explícito com a Meta chamando direto (firehose).
  const t3 = setInterval(() => {
    ctx.db
      .query(`DELETE FROM wa_events WHERE created_at < now() - interval '30 days' AND store <> 'pagarme'`)
      .catch(() => {});
  }, 6 * 3600 * 1000);

  t1.unref();
  t2.unref();
  t3.unref();
  t4.unref();
  return () => {
    clearInterval(t1);
    clearInterval(t2);
    clearInterval(t3);
    clearInterval(t4);
  };
}
