import { describe, expect, it } from 'vitest';
import { COPIES_DEFAULT } from './copies.js';
import {
  aprovarCorrecao, montarBodyEspelhado, registrarCorrecao, rejeitarCorrecao,
  splitNome, verificarReadback,
} from './correcoes.js';
import { FakeDb, configDisparoRow, ctxTeste, ofertaBase, rowBase } from '../test/fakes.js';

describe('montarBodyEspelhado (PUT = corpo COMPLETO espelhado)', () => {
  const atual = {
    id: 77,
    first_name: 'Maria',
    last_name: 'Silva',
    email: 'antigo@x.com',
    cpf: '04686204194',
    orders: { data: [{ id: 1 }] }, // relação incluída (readonly)
    created_at: { date: '2026-01-01 00:00:00', timezone: 'UTC' },
    updated_at: { date: '2026-01-01 00:00:00', timezone: 'UTC' },
    active: true,
  };

  it('mantém TODOS os campos escalares (omitido = zerado na Yampi!)', () => {
    const body = montarBodyEspelhado(atual, { email: 'novo@x.com' });
    expect(body.first_name).toBe('Maria');
    expect(body.last_name).toBe('Silva');
    expect(body.cpf).toBe('04686204194');
    expect(body.active).toBe(true);
    expect(body.email).toBe('novo@x.com');
  });

  it('descarta envelopes de relação e timestamps Carbon', () => {
    const body = montarBodyEspelhado(atual, {});
    expect(body).not.toHaveProperty('orders');
    expect(body).not.toHaveProperty('created_at');
    expect(body).not.toHaveProperty('updated_at');
  });

  it('mudança undefined não sobrescreve', () => {
    const body = montarBodyEspelhado(atual, { email: undefined });
    expect(body.email).toBe('antigo@x.com');
  });
});

describe('splitNome', () => {
  it('divide em first/last', () => {
    expect(splitNome('Maria da Silva Santos')).toEqual({ first_name: 'Maria', last_name: 'da Silva Santos' });
    expect(splitNome('Maria')).toEqual({ first_name: 'Maria', last_name: '' });
  });
});

describe('verificarReadback', () => {
  it('detecta divergência', () => {
    expect(verificarReadback({ email: 'a@x.com' }, { email: 'b@x.com' }, ['email'])).toEqual(['email']);
    expect(verificarReadback({ email: 'a@x.com' }, { email: 'a@x.com' }, ['email'])).toEqual([]);
  });
});

const pedidoComCliente = {
  id: 169610420,
  number: '151722',
  status: { data: { alias: 'paid' } },
  customer: { data: { id: 77, first_name: 'Maria', last_name: 'Silva', email: 'antigo@x.com', name: 'Maria Silva' } },
  shipping_address: { data: { street: 'Rua A' } },
  enderecos: [
    { id: 555, zip_code: '66000000', street: 'Rua A', number: '10', complement: '', neighborhood: 'Centro', city: 'Belém', state: 'PA', receiver: 'Maria Silva' },
  ],
};

function yampiCorrecao() {
  const puts: any[] = [];
  let clienteAtual: any = { id: 77, first_name: 'Maria', last_name: 'Silva', email: 'antigo@x.com' };
  let enderecoAtual: any = { ...pedidoComCliente.enderecos[0] };
  return {
    puts,
    async getOrder() {
      return pedidoComCliente;
    },
    async getCustomer() {
      return clienteAtual;
    },
    async putCustomer(id: any, body: any) {
      puts.push({ recurso: 'customer', id, body });
      clienteAtual = { ...clienteAtual, ...body }; // simula aplicação
      return {};
    },
    async getOrderAddresses() {
      return [enderecoAtual];
    },
    async putOrderAddress(orderId: any, id: any, body: any) {
      puts.push({ recurso: 'order_address', orderId, id, body });
      enderecoAtual = { ...enderecoAtual, ...body };
      return {};
    },
    async comment() {
      return {};
    },
  };
}

function dbCorrecao() {
  const db = new FakeDb();
  const correcoes: any[] = [];
  db.on(/SELECT \* FROM wa_upsell WHERE store/, () => [rowBase({ etapa: 'corrigir_sac' })]);
  db.on(/SELECT \* FROM wa_upsell WHERE id/, () => [rowBase({ etapa: 'corrigir_sac' })]);
  db.on(/SELECT \* FROM disparos_config/, () => [configDisparoRow()]);
  db.on(/SELECT \* FROM ofertas WHERE id/, () => [ofertaBase({ copies: COPIES_DEFAULT })]);
  db.on(/INSERT INTO correcoes/, (values) => {
    correcoes.push({
      id: correcoes.length + 1,
      wa_upsell_id: values[0],
      campos_antes: values[1],
      campos_depois: values[2],
      put_yampi: values[3],
      status: 'aguardando_aprovacao',
    });
    return [{ id: correcoes.length }];
  });
  db.on(/SELECT \* FROM correcoes WHERE id/, (values) => {
    const c = correcoes.find((x) => x.id === Number(values[0]));
    return c ? [c] : [];
  });
  db.on(/UPDATE correcoes SET status='aprovada'/, (values) => {
    const c = correcoes.find((x) => x.id === Number(values[0]));
    if (c) c.status = 'aprovada';
    return [];
  });
  return { db, correcoes };
}

describe('registrarCorrecao', () => {
  it('guarda ANTES, DEPOIS e o PUT exato — status aguardando_aprovacao', async () => {
    const { db, correcoes } = dbCorrecao();
    const yampi = yampiCorrecao();
    const ctx = ctxTeste({ db, yampi: yampi as any });
    const r = await registrarCorrecao(ctx, 'hidrabene', 169610420, { email: 'novo@x.com' });
    expect(r.ok).toBe(true);
    const c = correcoes[0];
    expect(c.status).toBe('aguardando_aprovacao');
    expect(c.campos_antes).toEqual({ email: 'antigo@x.com' });
    expect(c.campos_depois).toEqual({ email: 'novo@x.com' });
    const put = c.put_yampi.puts[0];
    expect(put.recurso).toBe('customer');
    expect(put.body.email).toBe('novo@x.com');
    expect(put.body.first_name).toBe('Maria'); // corpo espelhado
    // NADA foi aplicado na Yampi ainda
    expect(yampi.puts.length).toBe(0);
  });

  it('endereço: usa o recurso orders/{id}/addresses/{addressId}', async () => {
    const { correcoes, db } = dbCorrecao();
    const yampi = yampiCorrecao();
    const ctx = ctxTeste({ db, yampi: yampi as any });
    const r = await registrarCorrecao(ctx, 'hidrabene', 169610420, {
      endereco: { street: 'Rua Nova', number: '99' },
    });
    expect(r.ok).toBe(true);
    const put = correcoes[0].put_yampi.puts[0];
    expect(put.recurso).toBe('order_address');
    expect(put.id).toBe(555);
    expect(put.body.street).toBe('Rua Nova');
    expect(put.body.city).toBe('Belém'); // espelhado, não zera
  });

  it('sem campos: erro', async () => {
    const { db } = dbCorrecao();
    const ctx = ctxTeste({ db, yampi: yampiCorrecao() as any });
    const r = await registrarCorrecao(ctx, 'hidrabene', 169610420, {});
    expect(r.ok).toBe(false);
  });
});

describe('aprovarCorrecao (aplica + read-back + fecha)', () => {
  // Aprovar é ato INTERNO: não manda nada pro cliente a menos que o operador
  // marque explicitamente (pedido do Jorge, 09/08 — validação importante).
  it('por padrão NÃO avisa o cliente', async () => {
    const { db } = dbCorrecao();
    const yampi = yampiCorrecao();
    const ctx = ctxTeste({ db, yampi: yampi as any });
    await registrarCorrecao(ctx, 'hidrabene', 169610420, { email: 'novo@x.com' });
    const r = await aprovarCorrecao(ctx, 1, 'jorge');
    expect(r.ok).toBe(true);
    expect(yampi.puts.length).toBe(1); // aplicou na Yampi
    expect(ctx.metaFake.enviadas.length).toBe(0); // e ficou quieto
  });

  it('fluxo completo (com avisar_cliente ligado)', async () => {
    const { db, correcoes } = dbCorrecao();
    const yampi = yampiCorrecao();
    const ctx = ctxTeste({ db, yampi: yampi as any });
    await registrarCorrecao(ctx, 'hidrabene', 169610420, { email: 'novo@x.com' });
    const r = await aprovarCorrecao(ctx, 1, 'jorge', true);
    expect(r.ok).toBe(true);
    expect(yampi.puts.length).toBe(1); // aplicou SÓ depois da aprovação
    // avisou o cliente
    expect((ctx.metaFake.enviadas[0] as any).text.body).toContain('Prontinho');
    // fechou a row
    const fech = db.achou(/UPDATE wa_upsell SET/).find((c) => JSON.stringify(c.values).includes('corrigido'));
    expect(fech).toBeTruthy();
    // marcou aplicada + auditoria
    expect(db.achou(/UPDATE correcoes SET status='aplicada'/).length).toBe(1);
    expect(db.achou(/INSERT INTO auditoria/).length).toBe(1);
  });

  it('read-back divergente: erro_aplicacao, NÃO fecha nem avisa aplicado', async () => {
    const { db } = dbCorrecao();
    const yampi = yampiCorrecao();
    // sabota o read-back: o PUT "não pega"
    yampi.putCustomer = async (id: any, body: any) => {
      yampi.puts.push({ recurso: 'customer', id, body });
      return {};
    };
    const ctx = ctxTeste({ db, yampi: yampi as any });
    await registrarCorrecao(ctx, 'hidrabene', 169610420, { email: 'novo@x.com' });
    const r = await aprovarCorrecao(ctx, 1, 'jorge');
    expect(r.ok).toBe(false);
    expect(db.achou(/UPDATE correcoes SET status='erro_aplicacao'/).length).toBe(1);
    expect(ctx.metaFake.enviadas.length).toBe(0);
  });

  it('não aprova duas vezes', async () => {
    const { db, correcoes } = dbCorrecao();
    const ctx = ctxTeste({ db, yampi: yampiCorrecao() as any });
    await registrarCorrecao(ctx, 'hidrabene', 169610420, { email: 'novo@x.com' });
    correcoes[0].status = 'aplicada';
    const r = await aprovarCorrecao(ctx, 1, 'jorge');
    expect(r.ok).toBe(false);
  });
});

describe('rejeitarCorrecao', () => {
  // "Ignorar" no painel = rejeitar em silêncio (nada é enviado ao cliente)
  it('ignorar: marca rejeitada SEM avisar ninguém', async () => {
    const { db } = dbCorrecao();
    const ctx = ctxTeste({ db, yampi: yampiCorrecao() as any });
    await registrarCorrecao(ctx, 'hidrabene', 169610420, { email: 'novo@x.com' });
    const r = await rejeitarCorrecao(ctx, 1, 'jorge', 'ignorada no painel');
    expect(r.ok).toBe(true);
    expect(db.achou(/UPDATE correcoes SET status='rejeitada'/).length).toBe(1);
    expect(ctx.metaFake.enviadas.length).toBe(0);
  });

  it('marca rejeitada, avisa o cliente e audita (row segue open)', async () => {
    const { db, correcoes } = dbCorrecao();
    const ctx = ctxTeste({ db, yampi: yampiCorrecao() as any });
    await registrarCorrecao(ctx, 'hidrabene', 169610420, { email: 'novo@x.com' });
    const r = await rejeitarCorrecao(ctx, 1, 'jorge', 'dados inconsistentes', true);
    expect(r.ok).toBe(true);
    expect(db.achou(/UPDATE correcoes SET status='rejeitada'/).length).toBe(1);
    expect((ctx.metaFake.enviadas[0] as any).text.body).toContain('confirmar alguns detalhes');
    // nenhum fechamento da row
    expect(db.achou(/UPDATE wa_upsell SET/).filter((c) => JSON.stringify(c.values).includes('closed')).length).toBe(0);
  });
});
