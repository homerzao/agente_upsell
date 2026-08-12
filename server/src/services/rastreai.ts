// RastreiAI — página de rastreio que o cliente acompanha (rastreio.hidrabene.com.br).
//
// PROBLEMA QUE ISSO RESOLVE: o produto do upsell é cobrado numa cobrança PIX avulsa e o
// faturamento adiciona a unidade na hora de despachar. O pedido da Yampi não muda, então a
// página de rastreio mostrava só os itens originais — cliente que pagou a oferta abria o
// rastreio e não via o produto (motivo de contato no suporte).
//
// GOTCHA CRÍTICO: a rota NÃO é idempotente — cada POST ADICIONA o item de novo. Nunca
// chamar sem um claim atômico antes (wa_upsell_pagamentos.rastreai_enviado_em).
// Também não existe GET: a única leitura é o próprio POST, que devolve a lista final.

export type RastreaiService = ReturnType<typeof criarRastreai>;

type FetchFn = typeof fetch;

// O nome vai para a página do cliente; nome comprido quebra o layout.
// Corta o que é redundante (gramatura, "facial") antes de truncar.
export function nomeCurto(nome: string, max = 40): string {
  let n = String(nome ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!n) return 'PRODUTO';
  const podas = [
    /\s*-?\s*\b\d+\s?(ML|G|GR|KG|L)\b/g,        // 50g, 120ml
    /\s*\b\d+\s?UNIDADES?\b/g,                   // 25 unidades
    /\s*\bDE LIMPEZA\b/g,
    /\s*\bFACIAL\b/g,
  ];
  for (const p of podas) {
    if (n.length <= max) break;
    n = n.replace(p, ' ').replace(/\s+/g, ' ').replace(/\s+\+/g, ' +').trim();
  }
  if (n.length <= max) return n;
  const corte = n.slice(0, max);
  const esp = corte.lastIndexOf(' ');
  return (esp > max * 0.6 ? corte.slice(0, esp) : corte).trim();
}

export function criarRastreai(
  cfg: { RASTREAI_URL: string; RASTREAI_TOKEN: string },
  fetchFn: FetchFn = fetch,
) {
  const base = cfg.RASTREAI_URL.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.RASTREAI_TOKEN}`,
  };

  /** Adiciona itens ao pedido do rastreio. Devolve a lista final de itens do pedido. */
  async function adicionarItens(
    orderNumber: string,
    itens: Array<{ name: string; quantity: number }>,
  ): Promise<{ ok: boolean; orderId?: number; orderItems?: Array<{ name: string; quantity: number }> }> {
    if (!orderNumber) throw new Error('rastreai: orderNumber vazio');
    const body = {
      orderNumber: String(orderNumber),
      items: itens.map((i) => ({ name: nomeCurto(i.name), quantity: Math.max(1, Number(i.quantity) || 1) })),
    };
    const r = await fetchFn(`${base}/cashback/order-items`, { method: 'POST', headers, body: JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`rastreai ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }

  const adicionarItem = (orderNumber: string, name: string, quantity = 1) =>
    adicionarItens(orderNumber, [{ name, quantity }]);

  return { adicionarItens, adicionarItem };
}
