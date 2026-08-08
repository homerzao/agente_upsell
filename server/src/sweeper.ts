// Jobs periódicos:
// - a cada 60s: expira PIX vencido (10min), fecha sem_resposta (25min) e corrigir_sac (4h)
// - a cada 5s: drena a fila de disparo respeitando kill switch e rate/hora
// - a cada 6h: retenção de wa_events (30 dias; eventos de pagamento ficam)
import { processarFilaDisparo, sweep, type FunilCtx } from './domain/funil.js';

export function startSweeper(ctx: FunilCtx): () => void {
  let rodandoSweep = false;
  let rodandoFila = false;

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

  // Limpeza: requisito explícito com a Meta chamando direto (firehose).
  const t3 = setInterval(() => {
    ctx.db
      .query(`DELETE FROM wa_events WHERE created_at < now() - interval '30 days' AND store <> 'pagarme'`)
      .catch(() => {});
  }, 6 * 3600 * 1000);

  t1.unref();
  t2.unref();
  t3.unref();
  return () => {
    clearInterval(t1);
    clearInterval(t2);
    clearInterval(t3);
  };
}
