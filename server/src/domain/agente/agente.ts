// Agente IA da conversa (Chatwoot -> OpenAI -> Chatwoot).
// Toda mensagem enviada é logada em mensagens_ia com o prompt/contexto usado.
import crypto from 'node:crypto';
import type { OpenAIService, ChatMessage } from '../../services/openai.js';
import { foneBr, mesmoFone, primeiroNome, soDigitos, valorBr } from '../../lib/util.js';
import { LABEL_HUMANO, LABEL_UPSELL } from '../../services/chatwoot.js';
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
  // DDD + últimos 8 dígitos: o wa_id da Meta vem sem o nono dígito (ver mesmoFone)
  const dig = foneBr(fone);
  if (!dig) return null;
  const w = await ctx.db.query(
    `SELECT * FROM wa_upsell WHERE store='hidrabene'
       AND right(customer_phone, 8) = right($1, 8)
       AND substring(customer_phone from 3 for 2) = substring($1 from 3 for 2)
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
  // Link de acompanhamento = base + NÚMERO do pedido Yampi (não o order_id interno)
  const numero = pedido?.numero || row.order_number || '';
  const base = ctx.cfg.RASTREIO_URL_BASE.replace(/\/*$/, '/');
  return {
    row,
    oferta,
    pedido,
    linkRastreio: numero ? `${base}${numero}` : null,
    pagamento: pg.rows[0] ? { valor: valorBr(Number(pg.rows[0].valor)), pago_em: String(pg.rows[0].pago_em) } : null,
    correcoesPendentes: pend.rows[0]?.n ?? 0,
  };
}

// Histórico SÓ do ciclo atual do funil. O mesmo cliente reaproveita a conversa
// do Chatwoot entre pedidos: sem este corte, o agente lê "essa oferta já
// encerrou" de um pedido antigo e repete isso com a oferta NOVA em pé — foi o
// que aconteceu no teste do Jorge (09/08), 14s depois de mandar o PIX.
// `criado_em` da row é resetado a cada disparo, então marca o início do ciclo.
async function historicoMensagens(
  ctx: AgenteCtx,
  conversaId: number,
  cicloDesde: string | Date | null,
  limite = 20,
): Promise<ChatMessage[]> {
  const r = await ctx.db.query(
    `SELECT direcao, texto FROM mensagens_ia
     WHERE conversa_id=$1 AND texto IS NOT NULL
       AND ($3::timestamptz IS NULL OR criado_em >= $3::timestamptz)
     ORDER BY id DESC LIMIT $2`,
    [conversaId, limite, cicloDesde ?? null],
  );
  return r.rows.reverse().map((m: any) => ({
    role: m.direcao === 'in' ? ('user' as const) : ('assistant' as const),
    content: m.texto,
  }));
}

// Mensagens pendentes que já "descansaram" o tempo do debounce: junta tudo o
// que o cliente mandou em sequência e responde UMA vez. Sem isso o agente
// responde cada fragmento ("oi" / "quero mudar" / "o endereço") como se fossem
// conversas separadas — foi o que gerou 6 correções do mesmo pedido (09/08).
export async function responderPendentes(ctx: AgenteCtx): Promise<void> {
  const seg = ctx.cfg.WA_UPSELL_DEBOUNCE_SEG;
  if (seg <= 0) return;
  const prontas = await ctx.db.query(
    `SELECT conversa_id, MAX(criado_em) AS ultima FROM mensagens_ia
     WHERE direcao='in' AND processada=false
     GROUP BY conversa_id
     HAVING MAX(criado_em) < now() - ($1 || ' seconds')::interval
     LIMIT 20`,
    [seg],
  );
  for (const p of prontas.rows) {
    // claim: marca como processadas ANTES de responder (duas voltas do sweeper
    // não podem responder a mesma coisa duas vezes)
    const msgs = await ctx.db.query(
      `UPDATE mensagens_ia SET processada=true
       WHERE conversa_id=$1 AND direcao='in' AND processada=false
       RETURNING texto, criado_em`,
      [p.conversa_id],
    );
    if (!msgs.rows.length) continue;
    const texto = msgs.rows
      .sort((a: any, b: any) => new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime())
      .map((m: any) => m.texto)
      .filter(Boolean)
      .join('\n');
    const c = await ctx.db.query(
      `SELECT c.*, w.customer_phone FROM conversas c
       LEFT JOIN wa_upsell w ON w.id = c.wa_upsell_id WHERE c.id=$1`,
      [p.conversa_id],
    );
    const conversa = c.rows[0];
    if (!conversa || conversa.status === 'humano' || conversa.liberada_em) continue;
    await responderComIA(ctx, Number(conversa.chatwoot_conversation_id), conversa.customer_phone ?? '', texto)
      .catch(async (e) => {
        await logEvento(ctx, 'hidrabene', {
          erro: 'responder_pendentes_falhou',
          conversa_id: p.conversa_id,
          detalhe: String((e as Error).message).slice(0, 300),
        });
      });
  }
}

// Entrada principal: mensagem do cliente chegou (webhook). Só REGISTRA — quem
// responde é o sweeper, depois do debounce (ou aqui mesmo, se debounce=0).
export async function processarMensagemCliente(
  ctx: AgenteCtx,
  chatwootConversationId: number,
  fone: string,
  texto: string,
): Promise<void> {
  const res = await resolverConversa(ctx, chatwootConversationId, fone);
  if (!res) return; // conversa fora do funil de upsell: não é nossa
  const { conversa } = res;
  if (conversa.liberada_em) return; // conversa devolvida ao SAC normal: não é mais nossa

  const comDebounce = ctx.cfg.WA_UPSELL_DEBOUNCE_SEG > 0 && conversa.status !== 'humano';
  await ctx.db.query(
    'INSERT INTO mensagens_ia (conversa_id, direcao, texto, processada) VALUES ($1,$2,$3,$4)',
    [conversa.id, 'in', texto, !comDebounce],
  );
  // Cliente FALOU: se a conversa já tinha sido arquivada (auto-arquivamento 30min
  // após voltar pro SAC), ela DESARQUIVA. Arquivada some da lista principal — e
  // ninguém pode sumir da tela justamente quando volta a falar. Só a fala do
  // cliente desarquiva; despedida automática do sistema (out) não.
  await ctx.db.query(
    'UPDATE conversas SET arquivada_em=NULL, atualizado_em=now() WHERE id=$1 AND arquivada_em IS NOT NULL',
    [conversa.id],
  );
  if (conversa.status === 'humano') return; // humano assumiu: bot fica quieto
  if (comDebounce) return; // o sweeper responde quando o cliente parar de digitar
  await responderComIA(ctx, chatwootConversationId, fone, texto);
}

// Gera e envia a resposta (não registra a mensagem do cliente — quem faz isso
// é processarMensagemCliente/responderPendentes).
export async function responderComIA(
  ctx: AgenteCtx,
  chatwootConversationId: number,
  fone: string,
  texto: string,
): Promise<void> {
  const res = await resolverConversa(ctx, chatwootConversationId, fone);
  if (!res) return;
  const { conversa, row } = res;
  if (conversa.liberada_em || conversa.status === 'humano') return;

  // Gotcha 24: em modo test o agente só conversa com o fone de teste —
  // NUNCA responde cliente real antes da decisão explícita de ir pra live.
  const cfgd = await getDisparosConfig(ctx);
  if (cfgd.modo === 'test' && !mesmoFone(fone, ctx.cfg.WA_FONE_TESTE)) return;

  const responder = async (msg: string) => {
    if (!ctx.chatwoot) return;
    await ctx.chatwoot.enviarMensagem(chatwootConversationId, msg);
  };

  // "Falar com atendente" NÃO transfere na hora (feedback do Jorge, 09/08: ela
  // jogava pro humano sem nem saber o que a cliente queria — e quase sempre o
  // caso era resolvível). Só transfere direto se a pessoa INSISTIR: a segunda
  // vez na mesma conversa vale como insistência. Fora isso, o modelo decide
  // (tool encaminhar_humano) depois de tentar entender e resolver.
  if (pedeHumano(texto)) {
    const jaPediu = await ctx.db.query(
      `SELECT COUNT(*)::int AS n FROM mensagens_ia
       WHERE conversa_id=$1 AND direcao='in' AND texto ~* '(atendente|humano|pessoa de verdade|falar com algu)'`,
      [conversa.id],
    );
    if (Number(jaPediu.rows[0]?.n ?? 0) > 1) {
      await encaminharHumano(ctx, conversa, 'cliente insistiu em falar com humano', `Cliente escreveu: "${texto.slice(0, 200)}"`);
      await responder('Claro! Já estou te passando pra alguém do time — só um instante 💙').catch(() => {});
      return;
    }
    // primeira vez: segue pro modelo, que vai perguntar o que ela precisa
  }

  if (!ctx.openai || !ctx.cfg.OPENAI_API_KEY) {
    await encaminharHumano(ctx, conversa, 'agente indisponível (sem OPENAI_API_KEY)', texto.slice(0, 200));
    return;
  }

  try {
    const contexto = await montarContexto(ctx, row);
    // Blocos sobrescritos no banco valem na hora, sem deploy (prompt_blocos)
    const over = await ctx.db
      .query('SELECT chave, conteudo FROM prompt_blocos')
      .then((r: any) => Object.fromEntries(r.rows.map((x: any) => [x.chave, x.conteudo])))
      .catch(() => ({}));
    const system = montarSystemPrompt(contexto, cfgd.treinamento, over);
    const historico = await historicoMensagens(ctx, conversa.id, (row as any).criado_em ?? null);
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
      // O modelo pode decidir CALAR: cliente que só mandou "ok"/"obrigada" não
      // precisa de mais uma mensagem simpática (vira loop de cordialidade).
      // Nunca deixar o marcador vazar pro cliente.
      const calar = /\[SEM_RESPOSTA\]/i.test(respostaFinal);
      const limpo = respostaFinal.replace(/\[SEM_RESPOSTA\]/gi, '').trim();
      if (calar && !limpo) {
        await ctx.db.query(
          `INSERT INTO mensagens_ia (conversa_id, direcao, texto, prompt_hash, contexto, tokens, custo)
           VALUES ($1,'out',$2,$3,$4,$5,$6)`,
          [
            conversa.id,
            '🔒 registro interno: o agente decidiu não responder (mensagem de encerramento do cliente)',
            promptHash,
            { system, mensagens: messages.length, silencio: true },
            totalTokens,
            totalCusto,
          ],
        );
      } else if (/00020101|br\.gov\.bcb\.pix/i.test(limpo || respostaFinal)) {
        // TRAVA DURA (360 de 10/08, conversa 377): a IA INVENTOU um código PIX
        // no texto — banco recusou, cliente desistiu. Código PIX só chega ao
        // cliente pela ferramenta oficial (reenviar_pix → mensagem própria).
        // Qualquer output do modelo com cara de código é suprimido e vira
        // handoff: melhor um humano assumir do que um código alucinado sair.
        await logEvento(ctx, 'hidrabene', {
          erro: 'ia_bloqueada_pix_no_texto',
          conversa_id: conversa.id,
          amostra: (limpo || respostaFinal).slice(0, 120),
        });
        await ctx.db.query(
          `INSERT INTO mensagens_ia (conversa_id, direcao, texto, prompt_hash, contexto, tokens, custo)
           VALUES ($1,'out',$2,$3,$4,$5,$6)`,
          [
            conversa.id,
            '🔒 registro interno: resposta BLOQUEADA (continha código PIX no texto — proibido). Encaminhado ao humano.',
            promptHash,
            { system, mensagens: messages.length, bloqueio_pix: true },
            totalTokens,
            totalCusto,
          ],
        );
        await encaminharHumano(ctx, conversa, 'resposta bloqueada: código PIX no texto', texto.slice(0, 200));
      } else {
        const texto = limpo || respostaFinal;
        await responder(texto);
        await ctx.db.query(
          `INSERT INTO mensagens_ia (conversa_id, direcao, texto, prompt_hash, contexto, tokens, custo)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [conversa.id, 'out', texto, promptHash, { system, mensagens: messages.length }, totalTokens, totalCusto],
        );
      }
    }
  } catch (e) {
    await logEvento(ctx, row.store, {
      erro: 'agente_falhou',
      conversa_id: conversa.id,
      detalhe: String((e as Error).message).slice(0, 300),
    });
    // Falha TÉCNICA (rede, API do modelo) NÃO cala o bot pra sempre: antes isso
    // marcava a conversa como 'humano' e, sem ninguém do outro lado, o cliente
    // ficava falando sozinho (aconteceu no teste do Jorge, 09/08). Avisa o SAC
    // pela nota + label, pede um minutinho e segue disponível na próxima msg.
    await ctx.chatwoot
      ?.enviarMensagem(
        chatwootConversationId,
        `⚠️ Falha técnica ao gerar a resposta (${String((e as Error).message).slice(0, 120)}). O bot segue ativo e tenta na próxima mensagem — se o cliente estiver esperando, alguém do time pode assumir.`,
        true,
      )
      .catch(() => {});
    await ctx.chatwoot?.setLabels(chatwootConversationId, [LABEL_UPSELL, LABEL_HUMANO]).catch(() => {});
    await responder(
      `Só um minutinho, ${primeiroNome(row.customer_name)} — deu um probleminha aqui do meu lado. Já te respondo 🙏`,
    ).catch(() => {});
  }
}
