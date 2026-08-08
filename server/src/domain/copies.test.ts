import { describe, expect, it } from 'vitest';
import { renderCopy, valorBr } from '../lib/util.js';
import { COPIES_DEFAULT, OFERTA_DEFAULT } from './copies.js';

describe('copies validadas (default da oferta)', () => {
  it('oferta default é o Kit Clareador validado em produção', () => {
    expect(OFERTA_DEFAULT.sku_yampi).toBe('2133823');
    expect(OFERTA_DEFAULT.preco).toBe(49.91);
    expect(OFERTA_DEFAULT.preco_de).toBe(149.9);
  });

  it('msg_aceite renderiza preço, minutos e mantém o gancho do código', () => {
    const msg = renderCopy(COPIES_DEFAULT.msg_aceite, {
      nome: 'Maria',
      produto: OFERTA_DEFAULT.nome,
      preco: valorBr(OFERTA_DEFAULT.preco),
      minutos: 5,
    });
    expect(msg).toContain('Ticket Dourado garantido, Maria!');
    expect(msg).toContain('R$ 49,91');
    expect(msg).toContain('vale por 5 minutos');
    expect(msg).toContain('MESMO frete');
    expect(msg).toContain('próxima mensagem 👇');
    expect(msg).not.toMatch(/\{\{/);
  });

  it('anotação Yampi segue o formato buscável do contrato', () => {
    const anotacao = renderCopy(COPIES_DEFAULT.anotacao_yampi, {
      produto: OFERTA_DEFAULT.nome,
      sku: OFERTA_DEFAULT.sku_yampi,
      qtd: 1,
      valor: valorBr(49.91),
      charge_id: 'ch_abc123',
    });
    expect(anotacao).toBe(
      '✅ UPSELL WPP ACEITO E PAGO | Kit Clareador Completo (SKU 2133823) x1 | R$ 49,91 | PIX ch_abc123 | ADICIONAR AO PEDIDO antes de faturar',
    );
  });

  it('msg_pago fecha o ciclo (🎉 + MESMO pedido + rastreio por aqui)', () => {
    const msg = renderCopy(COPIES_DEFAULT.msg_pago, { nome: 'Maria' });
    expect(msg).toContain('🎉 Pagamento confirmado, Maria!');
    expect(msg).toContain('MESMO pedido');
    expect(msg).toContain('rastreio');
  });

  it('msg_corrigir garante que o pedido NÃO fatura antes da correção', () => {
    const msg = renderCopy(COPIES_DEFAULT.msg_corrigir, { nome: 'Maria', numero: '151722' });
    expect(msg).toContain('NÃO será faturado');
    expect(msg).toContain('*#151722*');
  });

  it('todas as copies renderizam sem vazar placeholder', () => {
    const dados = {
      nome: 'M', nome_completo: 'M S', numero: '1', email: 'e@x', endereco: 'Rua',
      produto: 'Kit', preco: '49,91', minutos: 5, sku: '1', qtd: 1, valor: '49,91',
      charge_id: 'ch', resumo: 'endereço',
    };
    for (const [chave, tpl] of Object.entries(COPIES_DEFAULT)) {
      expect(renderCopy(tpl, dados), chave).not.toMatch(/\{\{/);
    }
  });
});
