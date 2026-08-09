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
    // Destrava no TechSAC: a resposta do cliente volta a cair na sessão normal
    // do SAC. Precisa do conversation_id INTERNO (display_id dá 404) — ele vem
    // do disparo via send_template. Sem ele, não adianta tentar.
    const interno = (
      await ctx.db.query('SELECT chatwoot_conv_interno AS i FROM conversas WHERE id=$1', [conversa.id])
    ).rows[0]?.i;
    if (!interno) {
      await logEvento(ctx, 'hidrabene', {
        erro: 'sem_conversation_id_interno',
        conversa_id: conversa.id,
        detalhe: 'conversa criada sem passar pelo send_template do TechSAC — destravar indisponível',
      });
    } else await ctx.chatwoot.destravarConversa(Number(interno)).catch(async (e) => {
      await logEvento(ctx, 'hidrabene', {
        erro: 'destravar_conversa_falhou',
        conversa_id: conversa.id,
        chatwoot_conversation_id: convId,
        detalhe: String((e as Error).message).slice(0, 200),
      });
    });
  } catch (e) {
    await logEvento(ctx, 'hidrabene', {
      erro: 'handoff_chatwoot_falhou',
      conversa_id: conversa.id,
      detalhe: String((e as Error).message).slice(0, 300),
    });
  }
}
