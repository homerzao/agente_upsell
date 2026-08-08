// Agente IA da conversa (Chatwoot -> OpenAI -> Chatwoot).
// Toda mensagem enviada é logada em mensagens_ia com o prompt/contexto usado.
import crypto from 'node:crypto';
import type { OpenAIService, ChatMessage } from '../../services/openai.js';
import { soDigitos, valorBr } from '../../lib/util.js';
import { getDisparosConfig, getOferta, getRow, logEvento, normalizarPedidoYampi, type FunilCtx } from '../funil.js';
import { encaminharHumano } from '../handoff.js';
import { montarSystemPrompt, type ContextoAgente } from './contexto.js';
import { TOOL_DEFS, executarTool } from './tools.js';
import type { WaUpsellRow } from '../tipos.js';

export type AgenteCtx = FunilCtx & { openai: OpenAIService | null };

const MAX_RODADAS_TOOLS = 5;

// Pedido explícito de humano (heurística; o modelo também decide via tool).
export function pedeHumano(texto: string): boolean {
  const t = texto.toLowerCase();
  return /\b(atendente|humano|pessoa de verdade|pessoa real|falar com (algu[eé]m|uma pessoa)|sac\b)/.test(t);
}

// Localiza a conversa e a row do funil a partir do webhook do Chatwoot.
export async function resolverConversa(
  ctx: AgenteCtx,
  chatwootConversationId: number,
  fone: string,
): Promise<{ conversa: any; row: WaUpsellRow } | null> {
  const c = await ctx.db.query('SELECT * FROM conversas WHERE chatwoot_conversation_id=$1', [chatwootConversationId]);
  if (c.rows.length) {
    const w = await ctx.db.query('SELECT * FROM wa_upsell WHERE id=$1', [c.rows[0].wa_upsell_id]);
    if (w.rows.length) return { conversa: c.rows[0], row: w.rows[0] as WaUpsellRow };
  }
  // Fallback: liga a conversa à row mais recente do fone (ex.: conversa criada
  // pelo próprio Chatwoot antes do nosso registro). SÓ rows que realmente
  // entraram no funil — fora_do_fluxo é SAC comum, não é conversa do bot
  // (gotcha 23 registra TODO pedido pago; sem este filtro o bot sequestraria
  // qualquer cliente recente que mandasse mensagem na inbox).
  const dig = soDigitos(fone);
  if (!dig) return null;
  const w = await ctx.db.query(
    `SELECT * FROM wa_upsell WHERE customer_phone=$1 AND store='hidrabene'
       AND etapa <> 'fora_do_fluxo' AND disparo_status IS NOT NULL
     ORDER BY criado_em DESC LIMIT 1`,
    [dig],
  );
  if (!w.rows.length) return null;
  const ins = await ctx.db.query(
    `INSERT INTO conversas (wa_upsell_id, chatwoot_conversation_id, status)
     VALUES ($1,$2,'bot')
     ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET atualizado_em=now()
     RETURNING *`,
    [w.rows[0].id, chatwootConversationId],
  );
  return { conversa: ins.rows[0], row: w.rows[0] as WaUpsellRow };
}

async function montarContexto(ctx: AgenteCtx, row: WaUpsellRow): Promise<ContextoAgente> {
  const oferta = await getOferta(ctx, row.oferta_id);
  const snap = (
    await ctx.db.query('SELECT payload FROM pedidos_status WHERE store=$1 AND order_id=$2', [row.store, row.order_id])
  ).rows[0]?.payload;
  let pedido: ContextoAgente['pedido'] = null;
  if (snap) {
    const p = normalizarPedidoYampi(snap);
    const items = snap.items?.data ?? snap.items ?? [];
    pedido = {
      numero: p.numero,
      status: p.status,
      itens: items.map((it: any) => ({
        titulo: it.sku?.data?.title ?? it.item_title ?? it.title ?? '',
        qtd: it.quantity ?? 1,
        preco: it.price != null ? Number(it.price) : null,
      })),
      total: snap.value_total != null ? Number(snap.value_total) : null,
      endereco: p.endereco,
      rastreio: snap.shipment?.data?.tracking_code ?? snap.track_code ?? null,
    };
  }
  const pg = await ctx.db.query(
    'SELECT valor, pago_em FROM wa_upsell_pagamentos WHERE store=$1 AND order_id=$2 ORDER BY id DESC LIMIT 1',
    [row.store, row.order_id],
  );
  const pend = await ctx.db.query(
    `SELECT COUNT(*)::int AS n FROM correcoes WHERE wa_upsell_id=$1 AND status='aguardando_aprovacao'`,
    [row.id],
  );
  return {
    row,
    oferta,
    pedido,
    pagamento: pg.rows[0] ? { valor: valorBr(Number(pg.rows[0].valor)), pago_em: String(pg.rows[0].pago_em) } : null,
    correcoesPendentes: pend.rows[0]?.n ?? 0,
  };
}

async function historicoMensagens(ctx: AgenteCtx, conversaId: number, limite = 20): Promise<ChatMessage[]> {
  const r = await ctx.db.query(
    `SELECT direcao, texto FROM mensagens_ia WHERE conversa_id=$1 AND texto IS NOT NULL
     ORDER BY id DESC LIMIT $2`,
    [conversaId, limite],
  );
  return r.rows.reverse().map((m: any) => ({
    role: m.direcao === 'in' ? ('user' as const) : ('assistant' as const),
    content: m.texto,
  }));
}

// Entrada principal: mensagem do cliente chegou (webhook message_created).
export async function processarMensagemCliente(
  ctx: AgenteCtx,
  chatwootConversationId: number,
  fone: string,
  texto: string,
): Promise<void> {
  const res = await resolverConversa(ctx, chatwootConversationId, fone);
  if (!res) return; // conversa fora do funil de upsell: não é nossa
  const { conversa, row } = res;

  await ctx.db.query('INSERT INTO mensagens_ia (conversa_id, direcao, texto) VALUES ($1,$2,$3)', [
    conversa.id, 'in', texto,
  ]);
  if (conversa.status === 'humano') return; // humano assumiu: bot fica quieto

  // Gotcha 24: em modo test o agente só conversa com o fone de teste —
  // NUNCA responde cliente real antes da decisão explícita de ir pra live.
  const cfgd = await getDisparosConfig(ctx);
  if (cfgd.modo === 'test' && soDigitos(fone) !== soDigitos(ctx.cfg.WA_FONE_TESTE)) return;

  const responder = async (msg: string) => {
    if (!ctx.chatwoot) return;
    await ctx.chatwoot.enviarMensagem(chatwootConversationId, msg);
  };

  if (pedeHumano(texto)) {
    await encaminharHumano(ctx, conversa, 'cliente pediu humano', `Cliente escreveu: "${texto.slice(0, 200)}"`);
    await responder('Claro! Já estou te passando pra alguém do nosso time — só um instante. 💙').catch(() => {});
    return;
  }

  if (!ctx.openai || !ctx.cfg.OPENAI_API_KEY) {
    await encaminharHumano(ctx, conversa, 'agente indisponível (sem OPENAI_API_KEY)', texto.slice(0, 200));
    return;
  }

  try {
    const contexto = await montarContexto(ctx, row);
    const system = montarSystemPrompt(contexto);
    const historico = await historicoMensagens(ctx, conversa.id);
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...historico];
    // (a mensagem atual já entrou no histórico via INSERT acima)

    let totalTokens = 0;
    let totalCusto = 0;
    let houveHandoff = false;
    let respostaFinal: string | null = null;

    for (let rodada = 0; rodada < MAX_RODADAS_TOOLS; rodada++) {
      const { message, usage } = await ctx.openai.chat(messages, TOOL_DEFS);
      totalTokens += usage.total_tokens;
      totalCusto += ctx.openai.custo(usage);
      messages.push(message);
      if (!message.tool_calls?.length) {
        respostaFinal = message.content;
        break;
      }
      for (const tc of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* args inválidos: executa com vazio */
        }
        const { resultado, handoff } = await executarTool(ctx, row, conversa, tc.function.name, args);
        houveHandoff = houveHandoff || handoff;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(resultado) });
      }
    }

    if (!respostaFinal && !houveHandoff) {
      // Modelo não concluiu (loop estourou): declara incapaz -> humano
      await encaminharHumano(ctx, conversa, 'modelo não concluiu resposta', texto.slice(0, 200));
      return;
    }

    if (respostaFinal) {
      const promptHash = crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex');
      await responder(respostaFinal);
      await ctx.db.query(
        `INSERT INTO mensagens_ia (conversa_id, direcao, texto, prompt_hash, contexto, tokens, custo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [conversa.id, 'out', respostaFinal, promptHash, { system, mensagens: messages.length }, totalTokens, totalCusto],
      );
    }
  } catch (e) {
    await logEvento(ctx, row.store, {
      erro: 'agente_falhou',
      conversa_id: conversa.id,
      detalhe: String((e as Error).message).slice(0, 300),
    });
    await encaminharHumano(ctx, conversa, 'erro do agente', String((e as Error).message).slice(0, 200));
  }
}
