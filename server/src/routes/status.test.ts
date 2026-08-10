import { describe, expect, it } from 'vitest';
import { formatarStatus } from './status.js';

describe('contrato da API de status (faturamento — NÃO quebrar)', () => {
  it('pedido inexistente: 200 closed/fora_do_fluxo (NUNCA 404)', () => {
    expect(formatarStatus(123, null, null)).toEqual({
      order_id: 123,
      status: 'closed',
      etapa: 'fora_do_fluxo',
      pagamento: null,
    });
  });

  it('pedido pago: shape completo com pagamento', () => {
    const row = {
      order_number: '1517221321295822',
      status: 'closed',
      etapa: 'pago',
      atualizado_em: '2026-08-07T21:14:37.930Z',
    };
    const pagamento = {
      pagarme_charge_id: 'ch_abc',
      pagarme_transaction_id: 'tran_abc',
      valor: '49.91',
      sku: '2133823',
      quantidade: 1,
      pago_em: '2026-08-07T21:14:37.941Z',
    };
    const r: any = formatarStatus(169610420, row, pagamento);
    expect(r).toEqual({
      order_id: 169610420,
      order_number: '1517221321295822',
      status: 'closed',
      etapa: 'pago',
      atualizado_em: '2026-08-07T21:14:37.930Z',
      pagamento: {
        pagarme_charge_id: 'ch_abc',
        pagarme_transaction_id: 'tran_abc',
        valor: '49.91',
        sku: '2133823',
        // ADICIONADO em 10/08 (multi-oferta): nome do produto junto do SKU.
        // Este toEqual é o guardião do contrato — ADICIONAR campo é seguro
        // (integração ignora extras), REMOVER quebra o faturamento. Se este
        // teste falhar por campo que SUMIU, é bug de verdade.
        produto: null,
        quantidade: 1,
        pago_em: '2026-08-07T21:14:37.941Z',
      },
    });
  });

  it('valor sempre string com 2 casas (contrato)', () => {
    const r: any = formatarStatus(1, { order_number: 'x', status: 'closed', etapa: 'pago', atualizado_em: 'ts' }, {
      pagarme_charge_id: 'ch', pagarme_transaction_id: 'tr', valor: 49.9, sku: 's', quantidade: 1, pago_em: 'ts',
    });
    expect(r.pagamento.valor).toBe('49.90');
  });

  it('aberto sem pagamento: pagamento null', () => {
    const r: any = formatarStatus(1, { order_number: 'x', status: 'open', etapa: 'aguardando_confirmacao', atualizado_em: 'ts' }, null);
    expect(r.status).toBe('open');
    expect(r.pagamento).toBeNull();
  });

  // Jorge, 10/08: "como o sistema vai saber o produto lá?" — o nome do produto
  // acompanha o SKU. Campo novo, nenhum removido: contrato segue compatível.
  it('devolve o NOME do produto junto do sku, sem quebrar o contrato antigo', () => {
    const r: any = formatarStatus(1, { order_number: 'X', status: 'closed', etapa: 'pago', atualizado_em: 'z' }, {
      pagarme_charge_id: 'ch_1', pagarme_transaction_id: 'tr_1', valor: '19.91',
      sku: '2046', produto: 'Protetor Solar Facial FPS 90 Toque Seco', quantidade: 1, pago_em: 'z',
    });
    expect(r.pagamento.sku).toBe('2046');
    expect(r.pagamento.produto).toBe('Protetor Solar Facial FPS 90 Toque Seco');
    // campos do contrato original intactos
    for (const k of ['pagarme_charge_id', 'pagarme_transaction_id', 'valor', 'quantidade', 'pago_em']) {
      expect(r.pagamento[k]).toBeDefined();
    }
  });

  it('SKU sem oferta cadastrada: produto vem null, nunca quebra', () => {
    const r: any = formatarStatus(1, { order_number: 'X', status: 'closed', etapa: 'pago', atualizado_em: 'z' }, {
      pagarme_charge_id: 'ch_2', valor: '10.00', sku: 'SKU-DESCONHECIDO', quantidade: 1, pago_em: 'z',
    });
    expect(r.pagamento.produto).toBeNull();
    expect(r.pagamento.sku).toBe('SKU-DESCONHECIDO');
  });
});
