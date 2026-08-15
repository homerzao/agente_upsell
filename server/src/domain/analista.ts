// IA analista de aprovações: revisa cada correção pendente e APROVA sozinha o
// caso claro, com os critérios extraídos das 50+ decisões reais do Jorge.
// Regras duras (não são prompt, são código):
//   1. Ela NUNCA rejeita — o que não é aprovação óbvia fica na fila humana com parecer.
//   2. Ela NUNCA envia mensagem ao cliente (aprovarCorrecao com avisar=false).
//   3. Cidade/UF/CEP nunca passam por ela (pré-checagem, nem chega no modelo).
// Os critérios ficam no bloco 'analista_aprovacoes' (prompt_blocos): editável
// no banco SEM deploy, mesmo mecanismo dos blocos do agente da conversa.
import type { ChatMessage } from '../services/openai.js';
import type { AgenteCtx } from './agente/agente.js';
import { aprovarCorrecao } from './correcoes.js';
import { getDisparosConfig, logEvento } from './funil.js';

export const BLOCO_ANALISTA = 'analista_aprovacoes';

// Espera de silêncio antes de analisar: o agente ATUALIZA a correção pendente a
// cada reconfirmação do cliente (criado_em é bumpado). Analisar cedo demais
// pega versão intermediária.
export const ESPERA_MINUTOS = 10;
const LOTE_POR_VOLTA = 5;

export const REGRAS_ANALISTA_PADRAO = `Você é a analista de aprovações de correções de dados de pedidos (nome, e-mail, endereço de entrega) de uma loja brasileira. Um agente de WhatsApp coleta a correção com o cliente; sua tarefa é decidir se ela pode ser aplicada sem revisão humana. O operador (Jorge) decidiu 50+ casos; os critérios dele, extraídos dessas decisões:

APROVAR (o caso claro, que ele aprovou SEMPRE):
- Erro de digitação/grafia: e-mail com typo (gmil→gmail, letras trocadas), rua/bairro/complemento com erro de escrita ("Cada"→"Casa", "Dentro"→"Centro", "Oesrazzoli"→"Pedrazzoli"), acentuação de nome.
- Troca completa de e-mail a pedido do cliente, mesmo mudando de provedor (hotmail→gmail).
- Número da casa corrigido (dígito trocado, a mais ou a menos: 14603→14503, 22→21, 1p64→1064).
- Complemento que continua sendo DADO de endereço (apto/bloco/sala corrigido ou acrescentado: "Apto 131-B", "Sala 803, 8º andar").
- Nome corrigido, completado ou invertido (Iracélia Maria→Maria Iracélia), e troca legítima de quem recebe ("Solange ou quem estiver", nome de outra pessoa por inteiro).
- Rua trocada por outra rua REAL quando CEP, bairro e cidade permanecem os mesmos.

DEIXAR PARA O HUMANO (ele recusou ou ia querer olhar):
- Complemento/campo virando INSTRUÇÃO DE ENTREGA em texto corrido ("Entregar na portaria do prédio, que funciona 24h", "Entrar na servidão e gritar") — instrução não é dado de endereço.
- Valor novo que não parece dado válido: rua que não é nome de rua ("Fator 70"), e-mail sem @ ou com domínio quebrado, número sem pé nem cabeça.
- Correção que não muda nada (antes = depois) ou payload confuso (um campo repetido sem alteração junto de outro que troca a pessoa inteira).
- Qualquer coisa que toque cidade, UF ou CEP.
- Qualquer caso em que você não esteja MUITO confiante. Na dúvida, deixe.

Responda SOMENTE com JSON, sem markdown: {"decisao":"aprovar"|"deixar","motivo":"uma frase objetiva"}`;

export type Decisao = { decisao: 'aprovar' | 'deixar'; motivo: string };

// Pré-checagens de código (não gastam modelo e não admitem erro de LLM).
// Retorna o motivo para DEIXAR, ou null se o caso pode ir ao modelo.
export function preChecagem(antes: any, depois: any): string | null {
  if (JSON.stringify(antes ?? {}) === JSON.stringify(depois ?? {})) {
    return 'sem mudança real (antes = depois) — provável duplicata; humano decide se rejeita';
  }
  const ea = (antes?.endereco ?? {}) as Record<string, unknown>;
  const ed = (depois?.endereco ?? {}) as Record<string, unknown>;
  for (const k of ['city', 'state', 'zip_code']) {
    const va = String(ea[k] ?? '').trim();
    const vd = String(ed[k] ?? '').trim();
    if (va !== vd) return `mexe em ${k} (cidade/UF/CEP mudam o frete) — nunca aprovar automaticamente`;
  }
  return null;
}

export function montarPromptAnalista(regras: string, correcao: { campos_antes: any; campos_depois: any }): ChatMessage[] {
  return [
    { role: 'system', content: regras },
    {
      role: 'user',
      content:
        `Correção aguardando aprovação:\n` +
        `ANTES : ${JSON.stringify(correcao.campos_antes ?? {})}\n` +
        `DEPOIS: ${JSON.stringify(correcao.campos_depois ?? {})}`,
    },
  ];
}

// Parse defensivo: QUALQUER coisa fora do contrato vira 'deixar'.
export function parseDecisao(texto: string | null | undefined): Decisao {
  const bruto = String(texto ?? '');
  const m = bruto.match(/\{[\s\S]*\}/);
  if (!m) return { decisao: 'deixar', motivo: 'resposta da IA ilegível' };
  try {
    const j = JSON.parse(m[0]);
    const motivo = String(j.motivo ?? '').slice(0, 300) || 'sem motivo';
    return j.decisao === 'aprovar' ? { decisao: 'aprovar', motivo } : { decisao: 'deixar', motivo };
  } catch {
    return { decisao: 'deixar', motivo: 'resposta da IA ilegível' };
  }
}

async function gravarParecer(ctx: AgenteCtx, id: number, d: Decisao): Promise<void> {
  await ctx.db.query(`UPDATE correcoes SET analista_decisao=$2, analista_parecer=$3 WHERE id=$1`, [
    id, d.decisao, d.motivo,
  ]);
}

// Uma volta da analista (chamada pelo sweeper). Claim atômico por correção:
// analista_em marca "já vista" — quem conseguir o UPDATE processa.
export async function analisarPendentes(ctx: AgenteCtx): Promise<void> {
  if (!ctx.openai) return;
  const cfg = await getDisparosConfig(ctx);
  if (!cfg.analista_ativo) return;

  const pend = await ctx.db.query(
    `SELECT c.id, c.campos_antes, c.campos_depois, w.order_id, w.store
       FROM correcoes c JOIN wa_upsell w ON w.id = c.wa_upsell_id
      WHERE c.status='aguardando_aprovacao' AND c.analista_em IS NULL
        AND c.criado_em < now() - ($1 || ' minutes')::interval
      ORDER BY c.id LIMIT ${LOTE_POR_VOLTA}`,
    [ESPERA_MINUTOS],
  );
  if (!pend.rows.length) return;

  // Bloco de regras sobrescrevível no banco (mesmo mecanismo do agente)
  const bloco = await ctx.db.query('SELECT conteudo FROM prompt_blocos WHERE chave=$1', [BLOCO_ANALISTA]);
  const regras = String(bloco.rows[0]?.conteudo ?? '') || REGRAS_ANALISTA_PADRAO;

  for (const c of pend.rows) {
    const claim = await ctx.db.query(
      `UPDATE correcoes SET analista_em=now() WHERE id=$1 AND analista_em IS NULL RETURNING id`,
      [c.id],
    );
    if (!claim.rows.length) continue;

    const barrado = preChecagem(c.campos_antes, c.campos_depois);
    if (barrado) {
      await gravarParecer(ctx, c.id, { decisao: 'deixar', motivo: barrado });
      await logEvento(ctx, c.store, { analista: 'deixou', correcao_id: c.id, motivo: barrado });
      continue;
    }

    let d: Decisao;
    try {
      const r = await ctx.openai.chat(montarPromptAnalista(regras, c));
      d = parseDecisao(r.message.content);
    } catch (e) {
      d = { decisao: 'deixar', motivo: `erro na análise: ${String((e as Error).message).slice(0, 200)}` };
    }

    if (d.decisao === 'aprovar') {
      // avisar=false FIXO no código: a analista jamais fala com o cliente.
      const r = await aprovarCorrecao(ctx, c.id, 'ia_analista', false);
      if (!r.ok) d = { decisao: 'aprovar', motivo: `${d.motivo} (aplicação falhou: ${r.erro})` };
      await gravarParecer(ctx, c.id, d);
      await logEvento(ctx, c.store, {
        analista: r.ok ? 'aprovou_aplicou' : 'aprovou_mas_falhou',
        correcao_id: c.id, order_id: c.order_id, motivo: d.motivo,
      });
    } else {
      await gravarParecer(ctx, c.id, d);
      await logEvento(ctx, c.store, { analista: 'deixou', correcao_id: c.id, motivo: d.motivo });
    }
  }
}
