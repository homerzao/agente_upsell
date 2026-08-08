import { describe, expect, it } from 'vitest';
import { COPIES_DEFAULT } from './copies.js';
import {
  FILA_DISPARO, aceitarOferta, chaveRateHora, confirmarPagamento, iniciarFunil,
  normalizarPedidoYampi, processarFilaDisparo, processarPedidoYampi, registrarResposta,
} from './funil.js';
import {
  FakeDb, FakeRedis, configDisparoRow, ctxTeste, fakePagarme, fakeYampi, ofertaBase, rowBase,
} from '../test/fakes.js';

const pedidoYampi = (over: Record<string, unknown> = {}) => ({
  id: 169610420,
  number: '1517221321295822',
  status: { data: { alias: 'paid' } },
  customer: {
    data: {
      id: 77,
      name: 'Maria da Silva',
      email: 'maria@example.com',
      cpf: '046.862.041-94',
      phone: { full_number: '+5511987654321' },
    },
  },
  shipping_address: {
    data: { street: 'Rua A', number: '10', neighborhood: 'Centro', city: 'Belém', uf: 'PA', zip_code: '66000-000' },
  },
  items: { data: [] },
  ...over,
});

describe('normalizarPedidoYampi', () => {
  it('extrai status, cliente, fone/cpf só dígitos e endereço com street', () => {
    const p = normalizarPedidoYampi(pedidoYampi());
    expect(p.orderId).toBe(169610420);
    expect(p.status).toBe('paid');
    expect(p.fone).toBe('5511987654321');
    expect(p.cpf).toBe('04686204194');
    expect(p.endereco).toBe('Rua A, 10, Centro, Belém/PA, CEP 66000-000');
  });
});

function dbFunil(over: {
  configRow?: Record<string, unknown>;
  oferta?: Record<string, unknown> | null;
  row?: Record<string, unknown> | null;
  prevStatus?: string | null;
  insere?: boolean;
} = {}) {
  const db = new FakeDb();
  db.on(/SELECT \* FROM disparos_config/, () => [configDisparoRow(over.configRow)]);
  db.on(/SELECT \* FROM ofertas WHERE ativo/, () => (over.oferta === null ? [] : [ofertaBase({ ...over.oferta, copies: COPIES_DEFAULT })]));
  db.on(/SELECT \* FROM ofertas WHERE id/, () => (over.oferta === null ? [] : [ofertaBase({ ...over.oferta, copies: COPIES_DEFAULT })]));
  db.on(/SELECT \* FROM wa_upsell WHERE store/, () => (over.row === null ? [] : [rowBase(over.row)]));
  db.on(/SELECT status FROM pedidos_status/, () => (over.prevStatus === undefined ? [] : over.prevStatus === null ? [] : [{ status: over.prevStatus }]));
  db.on(/INSERT INTO wa_upsell \(/, () => (over.insere === false ? [] : [{ order_id: 169610420 }]));
  return db;
}

describe('iniciarFunil (disparo controlado)', () => {
  it('CPF autorizado: registra open/aguardando_confirmacao e enfileira', async () => {
    const db = dbFunil();
    const ctx = ctxTeste({ db });
    await iniciarFunil(ctx, 'hidrabene', pedidoYampi());
    const ins = db.achou(/INSERT INTO wa_upsell \(/)[0];
    expect(ins.values).toContain('open');
    expect(ins.values).toContain('aguardando_confirmacao');
    expect(await ctx.redis.llen(FILA_DISPARO)).toBe(1);
  });

  it('CPF fora do filtro: registra closed/fora_do_fluxo SEM mensagem', async () => {
    const db = dbFunil();
    const ctx = ctxTeste({ db });
    await iniciarFunil(ctx, 'hidrabene', pedidoYampi({ customer: { data: { id: 1, name: 'X', cpf: '11122233344', phone: '5511900000000' } } }));
    const ins = db.achou(/INSERT INTO wa_upsell \(/)[0];
    expect(ins.values).toContain('closed');
    expect(ins.values).toContain('fora_do_fluxo');
    expect(await ctx.redis.llen(FILA_DISPARO)).toBe(0);
    expect(ctx.metaFake.enviadas.length).toBe(0);
  });

  it('pausado (kill switch): registra fora_do_fluxo', async () => {
    const db = dbFunil({ configRow: { pausado: true } });
    const ctx = ctxTeste({ db });
    await iniciarFunil(ctx, 'hidrabene', pedidoYampi());
    expect(db.achou(/INSERT INTO wa_upsell \(/)[0].values).toContain('fora_do_fluxo');
  });

  it('já iniciado (ON CONFLICT): não re-dispara nem decrementa amostra', async () => {
    const db = dbFunil({ insere: false, configRow: { amostra_restante: 5 } });
    const ctx = ctxTeste({ db });
    await iniciarFunil(ctx, 'hidrabene', pedidoYampi());
    expect(await ctx.redis.llen(FILA_DISPARO)).toBe(0);
    expect(db.achou(/amostra_restante - 1/).length).toBe(0);
  });

  it('amostragem: decrementa a cada disparo elegível', async () => {
    const db = dbFunil({ configRow: { amostra_restante: 3 } });
    const ctx = ctxTeste({ db });
    await iniciarFunil(ctx, 'hidrabene', pedidoYampi());
    expect(db.achou(/amostra_restante - 1/).length).toBe(1);
  });
});

describe('processarPedidoYampi (transição pra família paga)', () => {
  it('waiting_payment -> paid dispara', async () => {
    const db = dbFunil({ prevStatus: 'waiting_payment' });
    const ctx = ctxTeste({ db });
    await processarPedidoYampi(ctx, 'hidrabene', pedidoYampi());
    expect(db.achou(/INSERT INTO wa_upsell \(/).length).toBe(1);
  });
  it('paid -> invoiced NÃO re-dispara', async () => {
    const db = dbFunil({ prevStatus: 'paid' });
    const ctx = ctxTeste({ db });
    await processarPedidoYampi(ctx, 'hidrabene', pedidoYampi({ status: { data: { alias: 'invoiced' } } }));
    expect(db.achou(/INSERT INTO wa_upsell \(/).length).toBe(0);
  });
});

describe('processarFilaDisparo', () => {
  it('kill switch segura a fila (não perde o item)', async () => {
    const db = dbFunil({ configRow: { pausado: true } });
    const ctx = ctxTeste({ db });
    await ctx.redis.rpush(FILA_DISPARO, JSON.stringify({ store: 'hidrabene', order_id: 169610420 }));
    await processarFilaDisparo(ctx);
    expect(await ctx.redis.llen(FILA_DISPARO)).toBe(1);
    expect(ctx.metaFake.enviadas.length).toBe(0);
  });

  it('rate/hora esgotado para de drenar', async () => {
    const db = dbFunil({ configRow: { rate_por_hora: 2 } });
    const ctx = ctxTeste({ db });
    (ctx.redis as FakeRedis).valores.set(chaveRateHora(), '2');
    await ctx.redis.rpush(FILA_DISPARO, JSON.stringify({ store: 'hidrabene', order_id: 169610420 }));
    await processarFilaDisparo(ctx);
    expect(await ctx.redis.llen(FILA_DISPARO)).toBe(1);
  });

  it('dispara o template e marca enviado (modo test manda pro fone de teste)', async () => {
    const db = dbFunil({ row: { template_msg_id: null, disparo_status: 'fila' } });
    db.on(/SELECT payload FROM pedidos_status/, () => [{ payload: pedidoYampi() }]);
    const ctx = ctxTeste({ db });
    await ctx.redis.rpush(FILA_DISPARO, JSON.stringify({ store: 'hidrabene', order_id: 169610420 }));
    await processarFilaDisparo(ctx);
    expect(ctx.metaFake.enviadas.length).toBe(1);
    const tpl: any = ctx.metaFake.enviadas[0];
    expect(tpl.to).toBe('5591992148793'); // modo test -> fone do Jorge
    expect(tpl.template.name).toBe('confirma_pedido_up_v4');
    const upd = db.achou(/UPDATE wa_upsell SET/).find((c) => c.text.includes('template_msg_id'));
    expect(upd?.values).toContain('enviado');
  });

  it('row já fechada/enviada: pula sem enviar', async () => {
    const db = dbFunil({ row: { status: 'closed' } });
    const ctx = ctxTeste({ db });
    await ctx.redis.rpush(FILA_DISPARO, JSON.stringify({ store: 'hidrabene', order_id: 169610420 }));
    await processarFilaDisparo(ctx);
    expect(ctx.metaFake.enviadas.length).toBe(0);
  });
});

describe('registrarResposta', () => {
  it('corrigir: etapa corrigir_sac (segue open) + pré-resposta', async () => {
    const db = dbFunil({ row: {} });
    const ctx = ctxTeste({ db });
    await registrarResposta(ctx, 'hidrabene', 169610420, { decisao: 'corrigir' });
    const upd = db.achou(/UPDATE wa_upsell SET/)[0];
    expect(upd.values).toContain('corrigir_sac');
    expect(upd.text).not.toContain("status='closed'");
    const msg: any = ctx.metaFake.enviadas[0];
    expect(msg.text.body).toContain('NÃO será faturado');
  });

  it('recusou: closed/recusado', async () => {
    const db = dbFunil();
    const ctx = ctxTeste({ db });
    await registrarResposta(ctx, 'hidrabene', 169610420, { oferta: 'recusar' });
    const upd = db.achou(/UPDATE wa_upsell SET/)[0];
    expect(upd.values).toContain('closed');
    expect(upd.values).toContain('recusado');
  });

  it('confirmou: etapa confirmado (segue open)', async () => {
    const db = dbFunil();
    const ctx = ctxTeste({ db });
    await registrarResposta(ctx, 'hidrabene', 169610420, { decisao: 'confirmar' });
    expect(db.achou(/UPDATE wa_upsell SET/)[0].values).toContain('confirmado');
  });
});

describe('aceitarOferta (PIX)', () => {
  it('fluxo feliz: msg 1 -> PIX -> pix_enviado com status open explícito -> código separado', async () => {
    const db = dbFunil({ row: {} });
    const ctx = ctxTeste({ db });
    await aceitarOferta(ctx, 'hidrabene', 169610420);
    expect(ctx.metaFake.enviadas.length).toBe(2);
    expect((ctx.metaFake.enviadas[0] as any).text.body).toContain('Ticket Dourado garantido');
    expect((ctx.metaFake.enviadas[1] as any).text.body).toBe('PIXCODE123'); // só o código
    const upd = db.achou(/UPDATE wa_upsell SET/).find((c) => c.text.includes('pix_charge_id'));
    expect(upd?.text).toContain("status=");
    expect(upd?.values).toContain('open');
    expect(upd?.values).toContain('pix_enviado');
    expect(upd?.values).toContain('ch_teste1');
  });

  it('idempotente: já em pix_enviado não cobra de novo', async () => {
    const db = dbFunil({ row: { etapa: 'pix_enviado' } });
    const ctx = ctxTeste({ db });
    await aceitarOferta(ctx, 'hidrabene', 169610420);
    expect(ctx.metaFake.enviadas.length).toBe(0);
  });

  it('sem CPF: erro_disparo, sem cobrança (Pagar.me exige document)', async () => {
    const db = dbFunil({ row: { customer_cpf: null } });
    const ctx = ctxTeste({ db });
    await aceitarOferta(ctx, 'hidrabene', 169610420);
    expect(db.achou(/UPDATE wa_upsell SET/)[0].values).toContain('erro_disparo');
    expect(ctx.metaFake.enviadas.length).toBe(0);
    expect(db.achou(/INSERT INTO wa_events/).some((c) => JSON.stringify(c.values).includes('pix_sem_cpf'))).toBe(true);
  });

  it('criação do PIX falhou: avisa instabilidade (nunca código fantasma)', async () => {
    const db = dbFunil({ row: {} });
    const ctx = ctxTeste({ db, pagarme: fakePagarme({ falhaCriar: 'pagarme 500' }) as any });
    await aceitarOferta(ctx, 'hidrabene', 169610420);
    expect(ctx.metaFake.enviadas.length).toBe(2);
    expect((ctx.metaFake.enviadas[1] as any).text.body).toContain('instabilidade');
  });

  it('sem qr_code após retries: instabilidade', async () => {
    const db = dbFunil({ row: {} });
    const ctx = ctxTeste({ db, pagarme: fakePagarme({ codigo: '' }) as any });
    await aceitarOferta(ctx, 'hidrabene', 169610420);
    expect((ctx.metaFake.enviadas[1] as any).text.body).toContain('instabilidade');
    expect(db.achou(/INSERT INTO wa_events/).some((c) => JSON.stringify(c.values).includes('pix_sem_qr_code'))).toBe(true);
  });
});

describe('confirmarPagamento (dedup atômico)', () => {
  const evento = { type: 'charge.paid', data: { id: 'ch_teste1', amount: 4991, last_transaction: { id: 'tran_1' } } };

  function dbPago(dedupJaExiste: boolean) {
    const db = dbFunil();
    db.on(/SELECT \* FROM wa_upsell WHERE pix_charge_id/, () => [rowBase({ pix_charge_id: 'ch_teste1', etapa: 'pix_enviado' })]);
    db.on(/INSERT INTO wa_upsell_pagamentos/, () => (dedupJaExiste ? [] : [{ id: 10 }]));
    return db;
  }

  it('primeiro evento: fecha pago, anota na Yampi e confirma no WhatsApp', async () => {
    const db = dbPago(false);
    const yampi = fakeYampi();
    const ctx = ctxTeste({ db, yampi: yampi as any });
    const ok = await confirmarPagamento(ctx, evento);
    expect(ok).toBe(true);
    const upd = db.achou(/UPDATE wa_upsell SET/)[0];
    expect(upd.values).toContain('closed');
    expect(upd.values).toContain('pago');
    expect(yampi.comments[0].texto).toContain('UPSELL WPP ACEITO E PAGO');
    expect(yampi.comments[0].texto).toContain('ch_teste1');
    expect((ctx.metaFake.enviadas[0] as any).text.body).toContain('🎉 Pagamento confirmado');
  });

  it('segundo evento do MESMO pagamento (charge.paid + order.paid): sai calado', async () => {
    const db = dbPago(true);
    const yampi = fakeYampi();
    const ctx = ctxTeste({ db, yampi: yampi as any });
    const ok = await confirmarPagamento(ctx, evento);
    expect(ok).toBe(true);
    expect(ctx.metaFake.enviadas.length).toBe(0);
    expect(yampi.comments.length).toBe(0);
    expect(db.achou(/UPDATE wa_upsell SET/).length).toBe(0);
  });

  it('charge desconhecida: false (não é nosso PIX)', async () => {
    const db = dbFunil();
    db.on(/SELECT \* FROM wa_upsell WHERE pix_charge_id/, () => []);
    const ctx = ctxTeste({ db });
    expect(await confirmarPagamento(ctx, evento)).toBe(false);
  });
});
