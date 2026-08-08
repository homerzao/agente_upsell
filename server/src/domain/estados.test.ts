import { describe, expect, it } from 'vitest';
import {
  FAMILIA_PAGA, decidirDisparo, destinoMensagem, ehStatusPago, ehTransicaoParaPago,
  interpretarRespostaFlow, parseFlowToken,
} from './estados.js';
import type { DisparosConfig } from './tipos.js';

describe('família paga', () => {
  it('contém exatamente os 7 status da régua da casa', () => {
    expect([...FAMILIA_PAGA].sort()).toEqual(
      ['delivered', 'handling_products', 'invoiced', 'on_carriage', 'paid', 'ready_for_shipping', 'shipment_exception'].sort(),
    );
  });
  it('ehStatusPago', () => {
    expect(ehStatusPago('paid')).toBe(true);
    expect(ehStatusPago('waiting_payment')).toBe(false);
    expect(ehStatusPago(null)).toBe(false);
  });
});

describe('ehTransicaoParaPago (dispara SÓ na transição)', () => {
  it('dispara: pendente -> pago', () => {
    expect(ehTransicaoParaPago('waiting_payment', 'paid')).toBe(true);
    expect(ehTransicaoParaPago(null, 'paid')).toBe(true); // primeiro evento já pago
  });
  it('NÃO re-dispara: pago -> pago (outra fase da família)', () => {
    expect(ehTransicaoParaPago('paid', 'invoiced')).toBe(false);
    expect(ehTransicaoParaPago('invoiced', 'delivered')).toBe(false);
  });
  it('não dispara fora da família', () => {
    expect(ehTransicaoParaPago('waiting_payment', 'cancelled')).toBe(false);
  });
});

describe('interpretarRespostaFlow (lógica validada)', () => {
  it('corrigir ganha de tudo', () => {
    expect(interpretarRespostaFlow({ decisao: 'corrigir_dados', oferta: 'aceito' })).toBe('corrigir');
    expect(interpretarRespostaFlow({ decisao_dados: 'Corrigir' })).toBe('corrigir');
  });
  it('aceite da oferta', () => {
    expect(interpretarRespostaFlow({ oferta: 'aceitar_oferta' })).toBe('aceitou');
    expect(interpretarRespostaFlow({ oferta: 'Sim, quero!' })).toBe('aceitou');
  });
  it('recusa', () => {
    expect(interpretarRespostaFlow({ oferta: 'recusar' })).toBe('recusou');
    expect(interpretarRespostaFlow({ oferta: 'não' })).toBe('recusou');
    expect(interpretarRespostaFlow({ oferta: 'nao_quero' })).toBe('recusou');
  });
  it('confirmação de dados', () => {
    expect(interpretarRespostaFlow({ decisao: 'confirmar' })).toBe('confirmou');
    expect(interpretarRespostaFlow({ decisao: 'ok_confirmado' })).toBe('confirmou');
  });
  it('flow v6: oferta expirada pelo servidor (fora da janela)', () => {
    expect(interpretarRespostaFlow({ oferta: 'expirada' })).toBe('expirou_flow');
    // ganha até do decisao confirmar que vem junto no fechamento
    expect(interpretarRespostaFlow({ decisao: 'confirmar', oferta: 'expirada' })).toBe('expirou_flow');
  });
  it('resposta irreconhecível vira null (não muda estado)', () => {
    expect(interpretarRespostaFlow({})).toBeNull();
    expect(interpretarRespostaFlow({ decisao: 'xyz' })).toBeNull();
  });
});

const cfgBase: DisparosConfig = {
  modo: 'test',
  cpf_filtro: [],
  rate_por_hora: 0,
  pausado: false,
  amostra_restante: null,
};

describe('decidirDisparo (disparo controlado)', () => {
  it('kill switch pausa tudo', () => {
    expect(decidirDisparo({ ...cfgBase, pausado: true }, '04686204194', true)).toEqual({
      elegivel: false,
      motivo: 'pausado',
    });
  });
  it('sem oferta ativa não dispara', () => {
    expect(decidirDisparo(cfgBase, '04686204194', false)).toEqual({
      elegivel: false,
      motivo: 'sem_oferta_ativa',
    });
  });
  it('piloto por CPF: só os autorizados', () => {
    const cfg = { ...cfgBase, cpf_filtro: ['04686204194'] };
    expect(decidirDisparo(cfg, '04686204194', true)).toEqual({ elegivel: true });
    expect(decidirDisparo(cfg, '046.862.041-94', true)).toEqual({ elegivel: true }); // formatado
    expect(decidirDisparo(cfg, '11122233344', true)).toEqual({ elegivel: false, motivo: 'cpf_fora_do_filtro' });
  });
  it('filtro vazio = aberto pra todos', () => {
    expect(decidirDisparo(cfgBase, '11122233344', true)).toEqual({ elegivel: true });
  });
  it('amostragem: esgotada pausa; com saldo dispara', () => {
    expect(decidirDisparo({ ...cfgBase, amostra_restante: 0 }, '111', true)).toEqual({
      elegivel: false,
      motivo: 'amostra_esgotada',
    });
    expect(decidirDisparo({ ...cfgBase, amostra_restante: 3 }, '111', true)).toEqual({ elegivel: true });
  });
});

describe('destinoMensagem (modo test manda tudo pro fone de teste)', () => {
  it('test -> fone do Jorge; live -> cliente', () => {
    expect(destinoMensagem('test', '5511987654321', '5591992148793')).toBe('5591992148793');
    expect(destinoMensagem('live', '5511987654321', '5591992148793')).toBe('5511987654321');
  });
});

describe('parseFlowToken', () => {
  it('parseia "store:order_id"', () => {
    expect(parseFlowToken('hidrabene:169610420')).toEqual({ store: 'hidrabene', orderId: 169610420 });
  });
  it('rejeita malformados', () => {
    expect(parseFlowToken('semdois-pontos')).toBeNull();
    expect(parseFlowToken('loja:abc')).toBeNull();
    expect(parseFlowToken('')).toBeNull();
    expect(parseFlowToken(undefined)).toBeNull();
  });
});
