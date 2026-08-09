// Yampi (api.dooki.com.br/v2).
// GOTCHAS: GETs de recursos ativos vêm CACHEADOS -> sempre _ts=<timestamp>;
// PUT = corpo COMPLETO espelhado (campos omitidos são ZERADOS);
// metadata é write-once -> marcar pedidos via anotações (comments);
// webhook criado via API nasce active:false -> PUT com events explícitos ativa.

export type YampiService = ReturnType<typeof criarYampi>;

type FetchFn = typeof fetch;

export function criarYampi(
  cfg: { YAMPI_ALIAS: string; YAMPI_TOKEN: string; YAMPI_SECRET: string },
  fetchFn: FetchFn = fetch,
) {
  const base = `https://api.dooki.com.br/v2/${cfg.YAMPI_ALIAS}`;
  const headers = {
    'Content-Type': 'application/json',
    'User-Token': cfg.YAMPI_TOKEN,
    'User-Secret-Key': cfg.YAMPI_SECRET,
  };

  async function req(method: string, path: string, body?: unknown): Promise<any> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${base}${path}${sep}_ts=${Date.now()}`; // cache-buster obrigatório
    const r = await fetchFn(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`yampi ${method} ${path} ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }

  const getOrder = async (orderId: number | string): Promise<any> =>
    (await req('GET', `/orders/${orderId}?include=items,customer,shipping_address,transactions,status,metadata`)).data;

  const getCustomer = async (customerId: number | string): Promise<any> =>
    (await req('GET', `/customers/${customerId}`)).data;

  // PUT espelhado: o caller monta o corpo COMPLETO (ver correcoes.montarPuts).
  const putOrder = (orderId: number | string, body: unknown) => req('PUT', `/orders/${orderId}`, body);
  const putCustomer = (customerId: number | string, body: unknown) => req('PUT', `/customers/${customerId}`, body);

  // Endereço de entrega do pedido tem recurso próprio: orders/{id}/addresses/{addressId}
  const getOrderAddresses = async (orderId: number | string): Promise<any[]> =>
    (await req('GET', `/orders/${orderId}/addresses`)).data ?? [];
  const putOrderAddress = (orderId: number | string, addressId: number | string, body: unknown) =>
    req('PUT', `/orders/${orderId}/addresses/${addressId}`, body);

  // Anotação ("Informações adicionais") — buscável no painel da Yampi.
  const comment = (orderId: number | string, texto: string) =>
    req('POST', `/orders/${orderId}/comments`, { comments: texto });

  // Caminho é /webhooks (NÃO /merchants/webhooks — esse dá 404; ver
  // docs/yampi-api-map.txt do agente_ecom).
  const listarWebhooks = async (): Promise<any[]> => (await req('GET', '/webhooks')).data ?? [];

  // Cria e ATIVA o webhook (nasce active:false; o PUT com a lista de events ativa).
  async function criarWebhookAtivo(url: string, events: string[]): Promise<any> {
    const criado = await req('POST', '/webhooks', { url, events });
    const id = criado?.data?.id ?? criado?.id;
    if (id) {
      await req('PUT', `/webhooks/${id}`, { url, events, active: true });
    }
    return criado;
  }

  return {
    req, getOrder, getCustomer, putOrder, putCustomer,
    getOrderAddresses, putOrderAddress, comment, listarWebhooks, criarWebhookAtivo,
  };
}
