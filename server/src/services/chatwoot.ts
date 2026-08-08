// Chatwoot (self-hosted TechSAC) — conversa do agente IA.
// Usuário API dedicado (CHATWOOT_API_TOKEN); inbox do WhatsApp (CHATWOOT_INBOX_ID).

export type ChatwootService = ReturnType<typeof criarChatwoot>;

type FetchFn = typeof fetch;

export const LABEL_UPSELL = 'upsell-ticket-dourado';
export const LABEL_HUMANO = 'precisa-humano';

export function criarChatwoot(
  cfg: {
    CHATWOOT_URL: string;
    CHATWOOT_ACCOUNT_ID: string;
    CHATWOOT_API_TOKEN: string;
    CHATWOOT_INBOX_ID: string;
    CHATWOOT_AGENT_ID: string;
    CHATWOOT_TEAM_ID: string;
  },
  fetchFn: FetchFn = fetch,
) {
  const base = `${cfg.CHATWOOT_URL.replace(/\/$/, '')}/api/v1/accounts/${cfg.CHATWOOT_ACCOUNT_ID}`;
  // Header com HÍFEN de propósito: o nginx na frente do TechSAC descarta headers
  // com underscore; o Rack normaliza api-access-token -> api_access_token lá dentro.
  const headers = { 'Content-Type': 'application/json', 'api-access-token': cfg.CHATWOOT_API_TOKEN };

  async function req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetchFn(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`chatwoot ${method} ${path} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }

  async function buscarContatoPorFone(fone: string): Promise<any | null> {
    const j = await req('GET', `/contacts/search?q=${encodeURIComponent('+' + fone)}`);
    return j.payload?.[0] ?? null;
  }

  async function criarContato(nome: string, fone: string): Promise<any> {
    const j = await req('POST', '/contacts', {
      name: nome,
      phone_number: `+${fone}`,
      inbox_id: Number(cfg.CHATWOOT_INBOX_ID),
    });
    return j.payload?.contact ?? j.payload ?? j;
  }

  // Conversa aberta do contato na inbox do WhatsApp; cria se não existir.
  async function buscarOuCriarConversa(contactId: number): Promise<any> {
    const convs = await req('GET', `/contacts/${contactId}/conversations`);
    const daInbox = (convs.payload ?? []).find(
      (c: any) => String(c.inbox_id) === String(cfg.CHATWOOT_INBOX_ID) && c.status !== 'resolved',
    );
    if (daInbox) return daInbox;
    return req('POST', '/conversations', {
      contact_id: contactId,
      inbox_id: Number(cfg.CHATWOOT_INBOX_ID),
    });
  }

  // Resposta do agente volta pelo Chatwoot (que entrega no WhatsApp).
  // Destrava a conversa no TechSAC (lock do fluxo deles): resposta do cliente
  // volta a cair na sessão normal do SAC. Rota custom do dev do TechSAC —
  // PATCH {locked:false}; usa o conversation_id (o dev expôs no send_template).
  const destravarConversa = (conversationId: number) =>
    req('PATCH', `/conversations/${conversationId}`, { locked: false });

  const enviarMensagem = (conversationId: number, content: string, privada = false) =>
    req('POST', `/conversations/${conversationId}/messages`, {
      content,
      message_type: 'outgoing',
      private: privada,
    });

  // (Sem espelho da fala do cliente: ela chega NATIVA no TechSAC pelo canal
  //  próprio. Nota interna é só pro que o agente/funil ENVIA — enviarMensagem
  //  com privada=true. Inbox WhatsApp rejeita incoming via API de toda forma.)

  const listarMensagens = async (conversationId: number): Promise<any[]> =>
    (await req('GET', `/conversations/${conversationId}/messages`)).payload ?? [];

  const atribuirAgente = (conversationId: number, assigneeId: number) =>
    req('POST', `/conversations/${conversationId}/assignments`, { assignee_id: assigneeId });

  const atribuirTime = (conversationId: number, teamId: number) =>
    req('POST', `/conversations/${conversationId}/assignments`, { team_id: teamId });

  const desatribuir = (conversationId: number) =>
    req('POST', `/conversations/${conversationId}/assignments`, { assignee_id: 0 });

  const setLabels = (conversationId: number, labels: string[]) =>
    req('POST', `/conversations/${conversationId}/labels`, { labels });

  const getLabels = async (conversationId: number): Promise<string[]> =>
    (await req('GET', `/conversations/${conversationId}/labels`)).payload ?? [];

  return {
    req,
    buscarContatoPorFone,
    criarContato,
    buscarOuCriarConversa,
    destravarConversa,
    enviarMensagem,
    listarMensagens,
    atribuirAgente,
    atribuirTime,
    desatribuir,
    setLabels,
    getLabels,
  };
}
