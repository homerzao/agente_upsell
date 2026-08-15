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
  // página pública do PIX (migration 016) — token opaco de 128 bits, estável
  pix_pagina_token?: string | null;
  // ticket de produto do pedido (migration 014) — análise de conversão por faixa
  valor_produtos?: number | string | null;
  // marcos do funil (migration 012) — usados pelo dashboard e pelas travas
  disparado_em: string | null;
  entregue_em: string | null;
  lido_em: string | null;
  abriu_flow_em: string | null;
  aceitou_em: string | null;
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
  // multi-oferta por faixa de ticket (migration 014): [ticket_min, ticket_max)
  // sobre o valor de produto do pedido; NULL = lado aberto. Prioridade maior
  // vence quando mais de uma faixa casa. sku_gatilho: reservado (fase 2).
  ticket_min?: number | null;
  ticket_max?: number | null;
  prioridade?: number;
  sku_gatilho?: string | null;
};

export type DisparosConfig = {
  modo: 'test' | 'live';
  cpf_filtro: string[];
  rate_por_hora: number;
  pausado: boolean;
  amostra_restante: number | null;
  treinamento: string; // estilo de escrita do agente IA (editável no painel)
  debug_meta: boolean; // loga resumo de todo webhook da Meta (aba Logs)
  metodos_permitidos: string[]; // alias Yampi aceitos no funil ([] = todos)
  analista_ativo: boolean; // IA analista de aprovações (kill switch)
};

export type RespostaFlow = {
  flow_token?: string;
  decisao?: string;
  decisao_dados?: string;
  oferta?: string;
  [k: string]: unknown;
};

export type AcaoResposta = 'corrigir' | 'aceitou' | 'recusou' | 'confirmou' | 'expirou_flow' | null;
