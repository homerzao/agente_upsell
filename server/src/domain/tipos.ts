// Tipos do domínio do funil.

export type StatusFunil = 'open' | 'closed';

export type Etapa =
  | 'aguardando_confirmacao'
  | 'confirmado'
  | 'corrigir_sac'
  | 'recusado'
  | 'pix_enviado'
  | 'pago'
  | 'expirado'
  | 'sem_resposta'
  | 'erro_disparo'
  | 'fora_do_fluxo';

export type WaUpsellRow = {
  id: number;
  store: string;
  order_id: number;
  order_number: string | null;
  customer_phone: string | null;
  customer_name: string | null;
  customer_cpf: string | null;
  customer_email: string | null;
  status: StatusFunil;
  etapa: Etapa;
  oferta_id: number | null;
  disparo_status: string | null;
  template_msg_id: string | null;
  pix_charge_id: string | null;
  pix_codigo: string | null;
  pix_enviado_em: string | null;
  pix_expira_em: string | null;
  criado_em: string;
  atualizado_em: string;
};

export type Oferta = {
  id: number;
  nome: string;
  sku_yampi: string;
  preco: number;
  preco_de: number | null;
  ativo: boolean;
  copies: Record<string, string>;
};

export type DisparosConfig = {
  modo: 'test' | 'live';
  cpf_filtro: string[];
  rate_por_hora: number;
  pausado: boolean;
  amostra_restante: number | null;
};

export type RespostaFlow = {
  flow_token?: string;
  decisao?: string;
  decisao_dados?: string;
  oferta?: string;
  [k: string]: unknown;
};

export type AcaoResposta = 'corrigir' | 'aceitou' | 'recusou' | 'confirmou' | 'expirou_flow' | null;
