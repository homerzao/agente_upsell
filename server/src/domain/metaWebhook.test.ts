import { describe, expect, it } from 'vitest';
import { COPIES_DEFAULT } from './copies.js';
import { processarWebhookMeta, reivindicarWamid } from './metaWebhook.js';
import { FakeDb, configDisparoRow, ctxTeste, ofertaBase, rowBase } from '../test/fakes.js';

const envelope = (value: Record<string, unknown>) => ({
  entry: [{ changes: [{ value }] }],
});

function dbMeta(over: { rowContexto?: Record<string, unknown> | null } = {}) {
  const db = new FakeDb();
  db.on(/SELECT \* FROM disparos_config/, () => [configDisparoRow()]);
  db.on(/SELECT \* FROM ofertas WHERE id/, () => [ofertaBase({ copies: COPIES_DEFAULT })]);
  db.on(/SELECT \* FROM wa_upsell WHERE store/, () => [rowBase()]);
  db.on(/SELECT \* FROM wa_upsell\s+WHERE \(?customer_phone/, () =>
    over.rowContexto === null ? [] : [rowBase(over.rowContexto)],
  );
  return db;
}

function chatwootFake() {
  const injetadas: any[] = [];
  return {
    injetadas,
    async buscarContatoPorFone() {
      return { id: 7 };
    },
    async criarContato() {
      return { id: 7 };
    },
    async buscarOuCriarConversa() {
      return { id: 555 };
    },
    async setLabels() {
      return {};
    },
    async atribuirAgente() {
      return {};
    },
    async injetarMensagemCliente(convId: number, content: string, sourceId: string) {
      injetadas.push({ convId, content, sourceId });
      return {};
    },
  };
}

describe('reivindicarWamid (dedup de reentrega)', () => {
  it('primeira vez OK, segunda não', async () => {
    const ctx = ctxTeste();
    expect(await reivindicarWamid(ctx, 'wamid.ABC')).toBe(true);
    expect(await reivindicarWamid(ctx, 'wamid.ABC')).toBe(false);
    expect(await reivindicarWamid(ctx, 'wamid.OUTRO')).toBe(true);
  });
});

describe('processarWebhookMeta (firehose filtrado)', () => {
  it('nfm_reply do funil: processa e persiste SÓ o evento aceito', async () => {
    const db = dbMeta();
    const ctx = ctxTeste({ db });
    await processarWebhookMeta(ctx, envelope({
      messages: [{
        id: 'wamid.1',
        interactive: { nfm_reply: { response_json: JSON.stringify({ flow_token: 'hidrabene:169610420', oferta: 'recusar' }) } },
      }],
    }));
    const eventos = db.achou(/INSERT INTO wa_events/);
    expect(eventos.length).toBe(1);
    expect(JSON.stringify(eventos[0].values)).toContain('nfm_reply');
    // processou: recusou -> closed
    expect(db.achou(/UPDATE wa_upsell SET/).some((c) => (c.values as any[]).includes('recusado'))).toBe(true);
  });

  it('reentrega do MESMO wamid: segunda chamada é descartada', async () => {
    const db = dbMeta();
    const ctx = ctxTeste({ db });
    const body = envelope({
      messages: [{
        id: 'wamid.dup',
        interactive: { nfm_reply: { response_json: JSON.stringify({ flow_token: 'hidrabene:169610420', oferta: 'recusar' }) } },
      }],
    });
    await processarWebhookMeta(ctx, body);
    const chamadas = db.calls.length;
    await processarWebhookMeta(ctx, body);
    expect(db.calls.length).toBe(chamadas); // nenhuma query nova
  });

  it('texto de lead em contexto ativo: garante a conversa SEM espelhar a fala do cliente', async () => {
    // A fala do cliente chega nativa no TechSAC — nota interna é só pro que SAI
    const db = dbMeta({ rowContexto: {} });
    const cw = chatwootFake();
    const ctx: any = { ...ctxTeste({ db }), chatwoot: cw };
    await processarWebhookMeta(ctx, envelope({
      messages: [{ id: 'wamid.2', type: 'text', from: '5511987654321', text: { body: 'oi, cadê meu pix?' } }],
    }));
    expect(cw.injetadas.length).toBe(0); // nada de espelho do inbound
    expect(db.achou(/INSERT INTO wa_events/).some((c) => JSON.stringify(c.values).includes('msg_cliente'))).toBe(true);
  });

  it('texto de fone FORA de contexto (SAC comum): descarta sem gravar NADA', async () => {
    const db = dbMeta({ rowContexto: null });
    const cw = chatwootFake();
    const ctx: any = { ...ctxTeste({ db }), chatwoot: cw };
    await processarWebhookMeta(ctx, envelope({
      messages: [{ id: 'wamid.3', type: 'text', from: '5511900000000', text: { body: 'quero comprar shampoo' } }],
    }));
    expect(cw.injetadas.length).toBe(0);
    expect(db.achou(/INSERT INTO wa_events/).length).toBe(0); // limpeza: nada persiste
  });

  it('status que bate com template nosso atualiza; os demais são descartados sem log', async () => {
    const db = dbMeta();
    const ctx = ctxTeste({ db });
    await processarWebhookMeta(ctx, envelope({
      statuses: [
        { id: 'wamid.tpl', status: 'delivered' },
        { id: 'wamid.sac-qualquer', status: 'delivered' },
        { id: 'wamid.x', status: 'sent' },
      ],
    }));
    const upds = db.achou(/disparo_status='entregue'/);
    expect(upds.length).toBe(2); // os dois delivered (o filtro real é o WHERE)
    expect(db.achou(/INSERT INTO wa_events/).length).toBe(0); // status não gera log
  });

  it('mídia/reação (não-texto, sem nfm): descarte silencioso', async () => {
    const db = dbMeta({ rowContexto: {} });
    const cw = chatwootFake();
    const ctx: any = { ...ctxTeste({ db }), chatwoot: cw };
    await processarWebhookMeta(ctx, envelope({
      messages: [{ id: 'wamid.4', type: 'image', from: '5511987654321', image: { id: 'media1' } }],
    }));
    expect(cw.injetadas.length).toBe(0);
    expect(db.achou(/INSERT INTO wa_events/).length).toBe(0);
  });

  it('formato forward do n8n (compat): {flow_token,...} processa direto', async () => {
    const db = dbMeta();
    const ctx = ctxTeste({ db });
    await processarWebhookMeta(ctx, { flow_token: 'hidrabene:169610420', oferta: 'recusar' });
    expect(db.achou(/UPDATE wa_upsell SET/).some((c) => (c.values as any[]).includes('recusado'))).toBe(true);
  });
});
