// Correções de dados do pedido com APROVAÇÃO HUMANA obrigatória.
// Fluxo: agente coleta -> registro aguardando_aprovacao (ANTES + DEPOIS + PUT exato)
//        -> operador aprova no painel -> aplica na Yampi -> verifica lendo de volta
//        -> avisa o cliente -> fecha. NUNCA aplicar update na Yampi sem aprovação.
// GOTCHA 13: PUT Yampi = corpo COMPLETO espelhado — campos omitidos são ZERADOS.
import { foneBr, primeiroNome, renderCopy, soDigitos } from '../lib/util.js';
import { destinoMensagem } from './estados.js';
import { getDisparosConfig, getOferta, getRow, logEvento, waupSet, type FunilCtx } from './funil.js';
import { normalizarPedidoYampi } from './funil.js';
import type { WaUpsellRow } from './tipos.js';

export type CamposCorrecao = {
  nome?: string;
  email?: string;
  endereco?: {
    zip_code?: string;
    street?: string;
    number?: string;
    complement?: string;
    neighborhood?: string;
    city?: string;
    state?: string;
    receiver?: string;
  };
};

export type PutYampi = { recurso: 'customer' | 'order_address'; id: number | string; order_id?: number; body: Record<string, unknown> };

// Corpo COMPLETO espelhado a partir do recurso atual: mantém todos os campos
// escalares, descarta envelopes de relação ({data:...}) e timestamps Carbon,
// e aplica só as mudanças pedidas. Puro — coberto por teste.
export function montarBodyEspelhado(atual: Record<string, any>, mudancas: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(atual ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('data' in v) continue; // relação incluída no GET (readonly)
      if ('date' in v && 'timezone' in v) continue; // Carbon {date, timezone}
      body[k] = v;
      continue;
    }
    body[k] = v;
  }
  delete body.created_at;
  delete body.updated_at;
  for (const [k, v] of Object.entries(mudancas)) {
    if (v !== undefined) body[k] = v;
  }
  return body;
}

// Divide nome completo em first/last (formato do customer da Yampi).
export function splitNome(nome: string): { first_name: string; last_name: string } {
  const partes = String(nome).trim().split(/\s+/);
  return { first_name: partes[0] ?? '', last_name: partes.slice(1).join(' ') };
}

export async function registrarCorrecao(
  ctx: FunilCtx,
  store: string,
  orderId: number,
  campos: CamposCorrecao,
): Promise<{ ok: boolean; correcaoId?: number; erro?: string; detalhe?: string }> {
  const row = await getRow(ctx, store, orderId);
  if (!row) return { ok: false, erro: 'pedido fora do fluxo' };
  if (!campos.nome && !campos.email && !campos.endereco) return { ok: false, erro: 'nenhum campo para corrigir' };

  // Lê o estado ATUAL na Yampi (antes) e monta os PUTs exatos que serão aplicados
  let pedido: any;
  try {
    pedido = await ctx.yampi.getOrder(orderId);
  } catch (e) {
    return { ok: false, erro: `falha ao ler pedido na Yampi: ${String((e as Error).message).slice(0, 200)}` };
  }
  const p = normalizarPedidoYampi(pedido);
  const cust = pedido.customer?.data ?? pedido.customer ?? {};
  const antes: Record<string, unknown> = {};
  const depois: Record<string, unknown> = {};
  const puts: PutYampi[] = [];

  if (campos.nome || campos.email) {
    if (!cust.id) return { ok: false, erro: 'pedido sem customer id na Yampi' };
    let clienteAtual: any;
    try {
      clienteAtual = await ctx.yampi.getCustomer(cust.id);
    } catch (e) {
      return { ok: false, erro: `falha ao ler cliente na Yampi: ${String((e as Error).message).slice(0, 200)}` };
    }
    const mudancas: Record<string, unknown> = {};
    if (campos.nome) {
      const { first_name, last_name } = splitNome(campos.nome);
      mudancas.first_name = first_name;
      mudancas.last_name = last_name;
      // `name` MANDA na Yampi: mandar só first/last e deixar o name velho no
      // corpo espelhado faz o antigo voltar (read-back divergente na correção 8,
      // Kátia, 09/08). Os três têm que ir juntos e coerentes.
      mudancas.name = campos.nome;
      antes.nome = clienteAtual.name ?? [clienteAtual.first_name, clienteAtual.last_name].filter(Boolean).join(' ');
      depois.nome = campos.nome;
    }
    if (campos.email) {
      mudancas.email = campos.email;
      antes.email = clienteAtual.email ?? null;
      depois.email = campos.email;
    }
    puts.push({ recurso: 'customer', id: cust.id, body: montarBodyEspelhado(clienteAtual, mudancas) });
  }

  if (campos.endereco) {
    // PROIBIDO alterar cidade, UF ou CEP (regra do Jorge, 09/08): esses campos
    // mudam o CUSTO DO FRETE já cobrado. A trava é aqui no código — o prompt
    // também proíbe, mas prompt não é barreira. A IA recebe o motivo e deve
    // avisar o cliente + encaminhar ao humano.
    const proibidos = ['city', 'state', 'uf', 'zip_code', 'cep', 'cidade', 'estado'] as const;
    const tentou = proibidos.filter((k) => {
      const v = (campos.endereco as Record<string, unknown>)[k];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
    if (tentou.length) {
      return {
        ok: false,
        erro: 'correcao_proibida_frete',
        detalhe:
          `Alterar ${tentou.join('/')} é proibido: muda o custo do frete do pedido. ` +
          'Avise o cliente que essa alteração não pode ser feita por aqui e encaminhe ao time humano.',
      };
    }
    let enderecos: any[];
    try {
      enderecos = await ctx.yampi.getOrderAddresses(orderId);
    } catch (e) {
      return { ok: false, erro: `falha ao ler endereços do pedido: ${String((e as Error).message).slice(0, 200)}` };
    }
    const alvo = enderecos[0];
    if (!alvo?.id) return { ok: false, erro: 'pedido sem endereço de entrega na Yampi' };
    const mudancas: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(campos.endereco)) {
      if (v !== undefined && v !== null && String(v).trim() !== '') mudancas[k] = v;
    }
    antes.endereco = {
      zip_code: alvo.zip_code ?? null, street: alvo.street ?? null, number: alvo.number ?? null,
      complement: alvo.complement ?? null, neighborhood: alvo.neighborhood ?? null,
      city: alvo.city ?? null, state: alvo.state ?? alvo.uf ?? null, receiver: alvo.receiver ?? null,
    };
    depois.endereco = { ...(antes.endereco as object), ...mudancas };
    puts.push({ recurso: 'order_address', id: alvo.id, order_id: orderId, body: montarBodyEspelhado(alvo, mudancas) });
  }

  // UMA correção pendente por pedido. O agente reconfirma com o cliente e
  // chamava a tool de novo a cada "sim" — no piloto real isso virou 6 correções
  // do MESMO pedido na fila de aprovação (09/08). Se já existe uma aguardando,
  // ATUALIZA (o pedido mais recente do cliente vence) em vez de empilhar.
  const pendente = await ctx.db.query(
    `SELECT id, campos_antes FROM correcoes
     WHERE wa_upsell_id=$1 AND status='aguardando_aprovacao'
     ORDER BY id DESC LIMIT 1`,
    [row.id],
  );
  if (pendente.rows.length) {
    const id = pendente.rows[0].id;
    // 'antes' preservado do primeiro registro: é o estado original na Yampi.
    // Conteúdo mudou -> zera o parecer da analista para ela reavaliar a versão nova.
    await ctx.db.query(
      `UPDATE correcoes SET campos_depois=$2, put_yampi=$3, criado_em=now(),
         analista_em=NULL, analista_decisao=NULL, analista_parecer=NULL WHERE id=$1`,
      [id, { ...(pendente.rows[0].campos_antes ?? {}), ...depois }, { puts }],
    );
    await waupSet(ctx, store, orderId, { status: 'open', etapa: 'corrigir_sac' });
    return { ok: true, correcaoId: id };
  }
  const ins = await ctx.db.query(
    `INSERT INTO correcoes (wa_upsell_id, campos_antes, campos_depois, put_yampi, status)
     VALUES ($1,$2,$3,$4,'aguardando_aprovacao') RETURNING id`,
    [row.id, antes, depois, { puts }],
  );
  // open explícito: correção registrada segura o faturamento até a decisão
  await waupSet(ctx, store, orderId, { status: 'open', etapa: 'corrigir_sac' });
  return { ok: true, correcaoId: ins.rows[0].id };
}

async function rowDaCorrecao(ctx: FunilCtx, correcaoId: number): Promise<{ correcao: any; row: WaUpsellRow } | null> {
  const c = await ctx.db.query('SELECT * FROM correcoes WHERE id=$1', [correcaoId]);
  if (!c.rows.length) return null;
  const w = await ctx.db.query('SELECT * FROM wa_upsell WHERE id=$1', [c.rows[0].wa_upsell_id]);
  if (!w.rows.length) return null;
  return { correcao: c.rows[0], row: w.rows[0] as WaUpsellRow };
}

// Compara o que foi lido de volta com o que deveria ter sido gravado.
export function verificarReadback(bodyEnviado: Record<string, unknown>, lido: Record<string, any>, chaves: string[]): string[] {
  const divergentes: string[] = [];
  // A Yampi RE-DERIVA first_name/last_name a partir do `name`: last_name vira a
  // ÚLTIMA palavra, o miolo fica só no `name`. Enviar "Silva Magnesi" e ler
  // "Magnesi" NÃO é falha — o `name`, que é o que manda, gravou certo.
  // Sem esta regra, 100% das correções de nome com sobrenome composto caíam em
  // erro_aplicacao mesmo tendo aplicado (5 casos reais até 15/08; um deles
  // deixou a row presa em corrigir_sac, segurando o faturamento).
  const nomeEnviado = String(bodyEnviado.name ?? '').trim();
  const nomeOk = nomeEnviado !== '' && nomeEnviado === String(lido?.name ?? '').trim();
  for (const k of chaves) {
    if (nomeOk && (k === 'first_name' || k === 'last_name')) continue;
    let esperado = String(bodyEnviado[k] ?? '').trim();
    let atual = String(lido?.[k] ?? '').trim();
    // A Yampi normaliza e-mail para minúsculas: comparar exato acusaria
    // divergência numa correção que deu certo (visto na prática, 09/08).
    if (k === 'email') {
      esperado = esperado.toLowerCase();
      atual = atual.toLowerCase();
    }
    if (esperado !== atual) divergentes.push(k);
  }
  return divergentes;
}

export async function aprovarCorrecao(
  ctx: FunilCtx,
  correcaoId: number,
  usuario: string,
  // NADA é enviado ao cliente por padrão: a aprovação é ato interno. Avisar é
  // decisão explícita de quem clica (pedido do Jorge, 09/08).
  avisarCliente = false,
): Promise<{ ok: boolean; erro?: string }> {
  const res = await rowDaCorrecao(ctx, correcaoId);
  if (!res) return { ok: false, erro: 'correção não encontrada' };
  const { correcao, row } = res;
  if (correcao.status !== 'aguardando_aprovacao') return { ok: false, erro: `status inválido: ${correcao.status}` };

  await ctx.db.query(
    `UPDATE correcoes SET status='aprovada', aprovador=$2, decidido_em=now() WHERE id=$1`,
    [correcaoId, usuario],
  );

  const puts: PutYampi[] = correcao.put_yampi?.puts ?? [];
  const depois = correcao.campos_depois ?? {};
  try {
    for (const put of puts) {
      if (put.recurso === 'customer') {
        await ctx.yampi.putCustomer(put.id, put.body);
        // read-back: confere que os campos pedidos realmente mudaram
        const lido = await ctx.yampi.getCustomer(put.id);
        const chaves = Object.keys(put.body).filter((k) => ['first_name', 'last_name', 'name', 'email'].includes(k));
        const div = verificarReadback(put.body, lido, chaves);
        if (div.length) throw new Error(`read-back divergente (customer): ${div.join(', ')}`);
      } else {
        await ctx.yampi.putOrderAddress(put.order_id ?? row.order_id, put.id, put.body);
        const lidos = await ctx.yampi.getOrderAddresses(put.order_id ?? row.order_id);
        const lido = lidos.find((a: any) => String(a.id) === String(put.id)) ?? lidos[0];
        const chaves = Object.keys((depois.endereco as object) ?? {});
        const div = verificarReadback(put.body, lido, chaves.filter((k) => k in put.body));
        if (div.length) throw new Error(`read-back divergente (endereço): ${div.join(', ')}`);
      }
    }
  } catch (e) {
    await ctx.db.query(`UPDATE correcoes SET status='erro_aplicacao', motivo=$2 WHERE id=$1`, [
      correcaoId,
      String((e as Error).message).slice(0, 300),
    ]);
    await logEvento(ctx, row.store, { erro: 'correcao_aplicacao_falhou', correcao_id: correcaoId, detalhe: String((e as Error).message).slice(0, 300) });
    return { ok: false, erro: String((e as Error).message).slice(0, 300) };
  }

  await ctx.db.query(`UPDATE correcoes SET status='aplicada', aplicado_em=now() WHERE id=$1`, [correcaoId]);

  // Avisa o cliente e fecha a row (correção resolvida libera o faturamento)
  const cfgd = await getDisparosConfig(ctx);
  const oferta = await getOferta(ctx, row.oferta_id);
  const resumo = Object.entries(depois)
    .map(([k, v]) => (k === 'endereco' ? 'endereço de entrega' : `${k}: ${String(v)}`))
    .join(', ');
  const msg = renderCopy(oferta?.copies?.msg_correcao_aplicada ?? '', {
    nome: primeiroNome(row.customer_name),
    numero: row.order_number ?? '',
    resumo,
  });
  if (msg && avisarCliente) {
    await ctx.meta
      .enviarTexto(destinoMensagem(cfgd.modo, foneBr(row.customer_phone), ctx.cfg.WA_FONE_TESTE), msg)
      .catch(async (e) => {
        await logEvento(ctx, row.store, { erro: 'msg_correcao_aplicada_falhou', order_id: row.order_id, detalhe: String((e as Error).message).slice(0, 300) });
      });
  }
  await waupSet(ctx, row.store, row.order_id, { status: 'closed', etapa: 'corrigido' });
  await ctx.db.query('INSERT INTO auditoria (usuario, acao, alvo, payload) VALUES ($1,$2,$3,$4)', [
    usuario, 'correcao_aprovada_aplicada', `correcao:${correcaoId}`, { order_id: row.order_id, depois },
  ]);
  return { ok: true };
}

export async function rejeitarCorrecao(
  ctx: FunilCtx,
  correcaoId: number,
  usuario: string,
  motivo: string,
  avisarCliente = false,
): Promise<{ ok: boolean; erro?: string }> {
  const res = await rowDaCorrecao(ctx, correcaoId);
  if (!res) return { ok: false, erro: 'correção não encontrada' };
  const { correcao, row } = res;
  if (correcao.status !== 'aguardando_aprovacao') return { ok: false, erro: `status inválido: ${correcao.status}` };
  await ctx.db.query(
    `UPDATE correcoes SET status='rejeitada', aprovador=$2, motivo=$3, decidido_em=now() WHERE id=$1`,
    [correcaoId, usuario, motivo || null],
  );
  // Avisa o cliente e encaminha ao humano (a row segue open/corrigir_sac até o SAC fechar)
  const cfgd = await getDisparosConfig(ctx);
  const oferta = await getOferta(ctx, row.oferta_id);
  const msg = renderCopy(oferta?.copies?.msg_correcao_rejeitada ?? '', { nome: primeiroNome(row.customer_name) });
  if (msg && avisarCliente) {
    // gotcha 7: falha de envio NUNCA é silenciosa
    await ctx.meta
      .enviarTexto(destinoMensagem(cfgd.modo, foneBr(row.customer_phone), ctx.cfg.WA_FONE_TESTE), msg)
      .catch(async (e) => {
        await logEvento(ctx, row.store, { erro: 'msg_correcao_rejeitada_falhou', order_id: row.order_id, detalhe: String((e as Error).message).slice(0, 300) });
      });
  }
  await ctx.db.query('INSERT INTO auditoria (usuario, acao, alvo, payload) VALUES ($1,$2,$3,$4)', [
    usuario, 'correcao_rejeitada', `correcao:${correcaoId}`, { order_id: row.order_id, motivo },
  ]);
  return { ok: true };
}
