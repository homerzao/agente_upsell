// Jobs periódicos:
// - a cada 60s: expira PIX vencido (10min) e fecha sem_resposta (4h)
// - a cada 5s: drena a fila de disparo respeitando kill switch e rate/hora
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

  t1.unref();
  t2.unref();
  return () => {
    clearInterval(t1);
    clearInterval(t2);
  };
}
