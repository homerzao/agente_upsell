import { describe, it, expect } from 'vitest';
import { criarRastreai, nomeCurto } from './rastreai.js';

describe('nomeCurto', () => {
  it('mantém nome que já cabe', () => {
    expect(nomeCurto('Kit Clareador Completo')).toBe('KIT CLAREADOR COMPLETO');
  });

  it('poda gramatura e "facial" antes de truncar', () => {
    expect(nomeCurto('Hidratante Anti-Aging Facial + Sabonete Facial Vit C 120ml'))
      .toBe('HIDRATANTE ANTI-AGING + SABONETE VIT C');
    expect(nomeCurto('Protetor Solar Facial FPS 70 Clareador 50g'))
      .toBe('PROTETOR SOLAR FACIAL FPS 70 CLAREADOR');
  });

  it('nunca passa do limite e corta em palavra inteira', () => {
    const n = nomeCurto('Combo Super Especial De Verao Com Nome Absurdamente Comprido Aqui', 40);
    expect(n.length).toBeLessThanOrEqual(40);
    expect(n.endsWith(' ')).toBe(false);
  });

  it('não devolve vazio', () => {
    expect(nomeCurto('')).toBe('PRODUTO');
  });
});

describe('adicionarItem', () => {
  it('posta orderNumber + itens com nome reduzido', async () => {
    let capturado: any = null;
    const fake = (async (url: string, init: any) => {
      capturado = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
      return { ok: true, json: async () => ({ ok: true, orderId: 1, orderItems: [] }) };
    }) as unknown as typeof fetch;

    const svc = criarRastreai({ RASTREAI_URL: 'https://api.x.com/api/v1/', RASTREAI_TOKEN: 'cb_tok' }, fake);
    const r = await svc.adicionarItem('1517221321295822', 'Protetor Solar Facial FPS 70 Clareador 50g');

    expect(r.ok).toBe(true);
    expect(capturado.url).toBe('https://api.x.com/api/v1/cashback/order-items');
    expect(capturado.auth).toBe('Bearer cb_tok');
    expect(capturado.body).toEqual({
      orderNumber: '1517221321295822',
      items: [{ name: 'PROTETOR SOLAR FACIAL FPS 70 CLAREADOR', quantity: 1 }],
    });
  });

  it('lança em erro HTTP (deixa o chamador desfazer o claim)', async () => {
    const fake = (async () => ({ ok: false, status: 422, json: async () => ({ erro: 'x' }) })) as unknown as typeof fetch;
    const svc = criarRastreai({ RASTREAI_URL: 'https://api.x.com/api/v1', RASTREAI_TOKEN: 't' }, fake);
    await expect(svc.adicionarItem('123', 'Produto')).rejects.toThrow(/rastreai 422/);
  });

  it('recusa pedido sem número', async () => {
    const svc = criarRastreai({ RASTREAI_URL: 'https://api.x.com/api/v1', RASTREAI_TOKEN: 't' });
    await expect(svc.adicionarItem('', 'Produto')).rejects.toThrow(/orderNumber vazio/);
  });
});
