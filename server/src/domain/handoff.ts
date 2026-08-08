// Handoff bot -> humano: desatribui o bot, atribui ao time humano,
// label precisa-humano e nota privada com o resumo da conversa.
import { LABEL_HUMANO, LABEL_UPSELL } from '../services/chatwoot.js';
import { logEvento, type FunilCtx } from './funil.js';

export async function encaminharHumano(
  ctx: FunilCtx,
  conversa: { id: number; chatwoot_conversation_id: number | null },
  motivo: string,
  resumo?: string,
): Promise<void> {
  await ctx.db.query(
    `UPDATE conversas SET status='humano', handoff_motivo=$2, atualizado_em=now() WHERE id=$1`,
    [conversa.id, motivo.slice(0, 300)],
  );
  const convId = conversa.chatwoot_conversation_id;
  if (!ctx.chatwoot || !convId) return;
  try {
    await ctx.chatwoot.setLabels(convId, [LABEL_UPSELL, LABEL_HUMANO]);
    if (ctx.cfg.CHATWOOT_TEAM_ID) {
      await ctx.chatwoot.atribuirTime(convId, Number(ctx.cfg.CHATWOOT_TEAM_ID));
    } else {
      await ctx.chatwoot.desatribuir(convId);
    }
    if (resumo) {
      await ctx.chatwoot.enviarMensagem(convId, `🤖➡️👤 Handoff (${motivo}).\n\nResumo: ${resumo}`, true);
    }
  } catch (e) {
    await logEvento(ctx, 'hidrabene', {
      erro: 'handoff_chatwoot_falhou',
      conversa_id: conversa.id,
      detalhe: String((e as Error).message).slice(0, 300),
    });
  }
}
