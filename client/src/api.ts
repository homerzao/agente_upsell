// Cliente da API do painel: sessão via cookie httpOnly + CSRF em header.

let csrfToken: string | null = null;

export function setCsrf(token: string | null): void {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as any) };
  if (csrfToken && init.method && init.method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  const r = await fetch(path, { credentials: 'include', ...init, headers });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && !path.includes('/auth/')) window.location.href = '/login';
    throw new ApiError(r.status, (j as any).error ?? `HTTP ${r.status}`);
  }
  return j as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });

export const fmtBRL = (v: number | string | null | undefined) =>
  v === null || v === undefined
    ? '—'
    : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const fmtDataHora = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';

export const ETAPA_LABEL: Record<string, string> = {
  aguardando_confirmacao: 'Aguardando confirmação',
  confirmado: 'Dados confirmados',
  corrigir_sac: 'Correção em andamento',
  corrigido: 'Corrigido',
  recusado: 'Recusou',
  pix_enviado: 'PIX enviado',
  pago: 'Pago 🏆',
  expirado: 'PIX expirou',
  sem_resposta: 'Sem resposta',
  erro_disparo: 'Erro no disparo',
  fora_do_fluxo: 'Fora do fluxo',
};
