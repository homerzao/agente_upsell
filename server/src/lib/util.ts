// Utilitários compartilhados (puros — cobertos por teste).

export const soDigitos = (s: unknown): string => String(s ?? '').replace(/\D/g, '');

// Fone brasileiro normalizado em dígitos E.164 (SEMPRE com DDI 55).
// A Yampi manda o fone nacional (DDD+número, 10-11 dígitos); a Meta manda com 55.
// Sem isso o match webhook×row falha e o envio em modo live iria pro número errado.
export const foneBr = (s: unknown): string => {
  const d = soDigitos(s);
  if (d.length === 10 || d.length === 11) return `55${d}`; // nacional -> +55
  return d; // já com DDI (12-13 dígitos) ou vazio/estrangeiro: mantém
};

// Mesmo assinante? Compara DDD + ÚLTIMOS 8 dígitos. O wa_id da Meta vem SEM o
// nono dígito (5591 92148793) e a Yampi grava COM (5591 992148793): comparar a
// string inteira dá "números diferentes" pro mesmo cliente.
export const mesmoFone = (a: unknown, b: unknown): boolean => {
  const x = foneBr(a), y = foneBr(b);
  if (x.length < 10 || y.length < 10) return false;
  return x.slice(-8) === y.slice(-8) && x.slice(2, 4) === y.slice(2, 4);
};

export const primeiroNome = (nome: unknown): string =>
  (String(nome ?? '').trim().split(/\s+/)[0] || 'cliente');

// Datas Yampi vêm em formato Carbon {date, timezone} em America/Sao_Paulo sem
// offset -> normaliza para ISO com -03:00 fixo.
export const carbon = (v: unknown): string | null => {
  const s = (v && typeof v === 'object' ? (v as any).date : v) ?? null;
  if (!s) return null;
  return String(s).replace(' ', 'T').replace(/\.\d+$/, '') + '-03:00';
};

export const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);

// O agente IA nunca ecoa CPF completo (guardrail de privacidade).
export const mascararCpf = (cpf: unknown): string => {
  const d = soDigitos(cpf);
  if (d.length < 5) return '***';
  return `${d.slice(0, 3)}***${d.slice(-2)}`;
};

// Renderização de copies: placeholders {{chave}} substituídos pelos dados.
// Placeholder sem valor vira '' (nunca vaza "{{nome}}" pro cliente).
export const renderCopy = (tpl: string, dados: Record<string, string | number | null | undefined>): string =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = dados[k];
    return v === null || v === undefined ? '' : String(v);
  });

export const valorBr = (v: number): string => v.toFixed(2).replace('.', ',');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
