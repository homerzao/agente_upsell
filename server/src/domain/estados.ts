// Regras puras da máquina de estados (sem IO — cobertas por teste).
import type { AcaoResposta, DisparosConfig, RespostaFlow } from './tipos.js';
import { soDigitos } from '../lib/util.js';

// Família "paga" da Yampi: pagamento confirmado em qualquer fase pós-pagamento.
export const FAMILIA_PAGA = [
  'paid', 'invoiced', 'ready_for_shipping', 'on_carriage',
  'delivered', 'shipment_exception', 'handling_products',
] as const;

export const ehStatusPago = (status: string | null | undefined): boolean =>
  FAMILIA_PAGA.includes(String(status ?? '') as any);

// Disparo SÓ na transição para a família paga (nunca re-dispara).
export const ehTransicaoParaPago = (
  statusAnterior: string | null | undefined,
  statusNovo: string | null | undefined,
): boolean => !ehStatusPago(statusAnterior) && ehStatusPago(statusNovo);

// Interpretação da resposta do Flow (nfm_reply) — lógica validada do agente_ecom,
// com a recusa checada ANTES do aceite: "nao_quero" contém "quero" e era
// classificado como aceite na ordem original (os valores reais do flow —
// "aceitar"/"recusar" — se comportam igual nas duas ordens).
export function interpretarRespostaFlow(resposta: RespostaFlow): AcaoResposta {
  const dec = String(resposta?.decisao ?? resposta?.decisao_dados ?? '').toLowerCase();
  const oferta = String(resposta?.oferta ?? '').toLowerCase();
  if (dec.includes('corrigir')) return 'corrigir';
  // Flow v6: o SERVIDOR ocultou o ticket (fora da janela) e o flow fecha com
  // oferta='expirada' — checar ANTES dos outros branches de oferta.
  if (oferta.includes('expir')) return 'expirou_flow';
  if (oferta.includes('recus') || oferta.includes('nao') || oferta.includes('não')) return 'recusou';
  if (oferta.includes('aceit') || oferta.includes('quero') || oferta.includes('sim')) return 'aceitou';
  if (dec.includes('confirmar') || dec.includes('ok')) return 'confirmou';
  return null;
}

export type DecisaoDisparo =
  | { elegivel: true }
  | {
      elegivel: false;
      motivo:
        | 'pausado'
        | 'cpf_fora_do_filtro'
        | 'amostra_esgotada'
        | 'sem_oferta_ativa'
        | 'metodo_fora_do_filtro'
        | 'status_nao_e_paid'
        | 'pedido_antigo';
    };

// Elegibilidade do disparo controlado. Pedido NÃO elegível AINDA é registrado
// (closed/fora_do_fluxo): o faturamento consulta qualquer pedido e sempre recebe resposta.
export function decidirDisparo(
  cfg: DisparosConfig,
  cpf: string | null | undefined,
  temOfertaAtiva: boolean,
  metodoPagamento?: string | null,
  pedido?: { status?: string | null; idadeHoras?: number | null; idadeMaxHoras?: number },
): DecisaoDisparo {
  if (cfg.pausado) return { elegivel: false, motivo: 'pausado' };
  if (!temOfertaAtiva) return { elegivel: false, motivo: 'sem_oferta_ativa' };
  // A oferta é para quem ACABOU de pagar. Duas travas contra disparo em pedido
  // velho (achado real 09/08: 79 pedidos `invoiced` — pedidos de dias atrás
  // sendo faturados — entraram como se tivessem acabado de ser pagos, porque o
  // sistema nunca os tinha visto antes e leu isso como transição pra pago):
  if (pedido) {
    if (pedido.status && pedido.status !== 'paid') {
      return { elegivel: false, motivo: 'status_nao_e_paid' }; // invoiced, on_carriage, delivered…
    }
    const max = pedido.idadeMaxHoras ?? 24;
    if (pedido.idadeHoras !== null && pedido.idadeHoras !== undefined && pedido.idadeHoras > max) {
      return { elegivel: false, motivo: 'pedido_antigo' };
    }
  }
  // Método de pagamento (alias da Yampi: pix, mastercard, visa, elo, amex, billet…).
  // Padrão só PIX: quem pagou PIX está com o celular na mão e paga outro PIX.
  // Lista vazia = aceita todos. Pedido SEM método identificado não entra quando
  // há filtro — melhor deixar de fora que mandar oferta pra quem não devia.
  const metodos = (cfg.metodos_permitidos ?? []).map((m) => String(m).toLowerCase()).filter(Boolean);
  if (metodos.length && !metodos.includes(String(metodoPagamento ?? '').toLowerCase())) {
    return { elegivel: false, motivo: 'metodo_fora_do_filtro' };
  }
  if (cfg.amostra_restante !== null && cfg.amostra_restante <= 0) {
    return { elegivel: false, motivo: 'amostra_esgotada' };
  }
  const filtro = (cfg.cpf_filtro ?? []).map(soDigitos).filter(Boolean);
  if (filtro.length && !filtro.includes(soDigitos(cpf))) {
    return { elegivel: false, motivo: 'cpf_fora_do_filtro' };
  }
  return { elegivel: true };
}

// Modo test = TODAS as mensagens vão pro número de teste (Jorge), independente
// do destinatário real. live SÓ com decisão explícita no painel.
export const destinoMensagem = (modo: 'test' | 'live', foneCliente: string, foneTeste: string): string =>
  modo === 'live' ? foneCliente : foneTeste;

// flow_token do template: "store:order_id"
export const parseFlowToken = (token: unknown): { store: string; orderId: number } | null => {
  const [st, oid] = String(token ?? '').split(':');
  const n = Number(oid);
  if (!st || !oid || !Number.isFinite(n) || n <= 0) return null;
  return { store: st, orderId: n };
};
