// Teste de integração do data channel SIMULANDO A META ponta a ponta:
// cifra com a chave pública, chama o handler, decifra a resposta (IV invertido).
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decryptFlowResponseComoMeta, encryptFlowRequestComoMeta,
} from '../services/flowCrypto.js';
import { tratarFlowRequest } from './flow.js';
import { FakeDb, cfgTeste, configDisparoRow, ctxTeste, rowBase } from '../test/fakes.js';

let publica = '';
let privada = '';

beforeAll(() => {
  const par = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publica = par.publicKey;
  privada = par.privateKey;
});

function ctxFlow(over: { row?: Record<string, unknown> | null } = {}) {
  const db = new FakeDb();
  db.on(/SELECT \* FROM wa_upsell WHERE store/, () => (over.row === null ? [] : [rowBase(over.row)]));
  db.on(/SELECT \* FROM disparos_config/, () => [configDisparoRow()]);
  db.on(/SELECT \* FROM ofertas WHERE id/, () => [
    { id: 7, nome: 'Kit Clareador', sku_yampi: '2133823', preco: '49.91', preco_de: '149.90', ativo: true, copies: {} },
  ]);
  const ctx = ctxTeste({ db });
  (ctx as any).cfg = { ...ctx.cfg, ...cfgTeste(), FLOW_PRIVATE_KEY: privada };
  return { ctx, db };
}

describe('/flow/upsell (data channel do flow v6)', () => {
  it('ping responde status active (sem isso o flow nem publica)', async () => {
    const { ctx } = ctxFlow();
    const reqMeta = encryptFlowRequestComoMeta(publica, { version: '3.0', action: 'ping' });
    const r = await tratarFlowRequest(ctx as any, reqMeta);
    expect(r.status).toBe(200);
    const resposta: any = decryptFlowResponseComoMeta(reqMeta.aesKey, reqMeta.iv, r.body);
    expect(resposta).toEqual({ data: { status: 'active' } });
  });

  it('dentro da janela: mostra TICKET (ecoando os textos) e marca confirmado', async () => {
    const { ctx, db } = ctxFlow({ row: { status: 'open', etapa: 'aguardando_confirmacao' } });
    const reqMeta = encryptFlowRequestComoMeta(publica, {
      version: '3.0',
      action: 'data_exchange',
      flow_token: 'hidrabene:169610420',
      data: { titulo_ticket: '🏆 Maria, você desbloqueou o TICKET DOURADO', saudacao_ok: 'Tudo certo, Maria! ✅' },
    });
    const r = await tratarFlowRequest(ctx as any, reqMeta);
    expect(r.status).toBe(200);
    const resposta: any = decryptFlowResponseComoMeta(reqMeta.aesKey, reqMeta.iv, r.body);
    expect(resposta.screen).toBe('TICKET');
    expect(resposta.data.titulo_ticket).toContain('TICKET DOURADO');
    expect(db.achou(/UPDATE wa_upsell SET/)[0].values).toContain('confirmado');
  });

  // ===== Flow v8 (double-check + textos dinâmicos) =====

  it('v8 (fv=8): TICKET vem com TODOS os textos da oferta renderizados pelo servidor', async () => {
    const { ctx } = ctxFlow({ row: { status: 'open', etapa: 'aguardando_confirmacao' } });
    const reqMeta = encryptFlowRequestComoMeta(publica, {
      action: 'data_exchange',
      flow_token: 'hidrabene:169610420',
      data: { fv: '8', saudacao_ok: 'Tudo certo, Maria! ✅' },
    });
    const r = await tratarFlowRequest(ctx as any, reqMeta);
    const resposta: any = decryptFlowResponseComoMeta(reqMeta.aesKey, reqMeta.iv, r.body);
    expect(resposta.screen).toBe('TICKET');
    // textos que no v7 eram cravados no JSON agora vêm do servidor (multi-oferta)
    expect(resposta.data.oferta_bullets).toContain('Protetor Facial FPS 70');
    expect(resposta.data.oferta_preco_linha).toContain('49,91');
    expect(resposta.data.oferta_urgencia).toContain('UMA única vez');
    expect(resposta.data.saudacao_ok).toBe('Tudo certo, Maria! ✅');
  });

  it('v8: "quero" abre a CONFIRMA (double-check) SEM aceitar nem gerar PIX', async () => {
    const { ctx, db } = ctxFlow({ row: { status: 'open', etapa: 'confirmado' } });
    const reqMeta = encryptFlowRequestComoMeta(publica, {
      action: 'data_exchange',
      flow_token: 'hidrabene:169610420',
      data: { fv: '8', acao: 'quero', saudacao_ok: 'Tudo certo! ✅' },
    });
    const r = await tratarFlowRequest(ctx as any, reqMeta);
    const resposta: any = decryptFlowResponseComoMeta(reqMeta.aesKey, reqMeta.iv, r.body);
    expect(resposta.screen).toBe('CONFIRMA');
    expect(resposta.data.confirma_resumo).toContain('49,91');
    // métrica do clique acidental: o "quero" é logado…
    expect(db.achou(/INSERT INTO wa_events/).some((c) => JSON.stringify(c.values).includes('ticket_quero'))).toBe(true);
    // …mas NADA de aceite: sem PIX, sem mudança de etapa pra pix_enviado
    expect(ctx.metaFake.enviadas.length).toBe(0);
    expect(db.achou(/UPDATE wa_upsell SET/).filter((c) => JSON.stringify(c.values).includes('pix')).length).toBe(0);
  });

  it('v8: "quero" fora da janela cai na expirada (não mostra double-check de oferta morta)', async () => {
    const { ctx } = ctxFlow({ row: { status: 'closed', etapa: 'expirado' } });
    const reqMeta = encryptFlowRequestComoMeta(publica, {
      action: 'data_exchange',
      flow_token: 'hidrabene:169610420',
      data: { fv: '8', acao: 'quero', saudacao_ok: 'Ok! ✅' },
    });
    const r = await tratarFlowRequest(ctx as any, reqMeta);
    const resposta: any = decryptFlowResponseComoMeta(reqMeta.aesKey, reqMeta.iv, r.body);
    expect(resposta.screen).toBe('CONFIRMADO');
    expect(resposta.data.oferta_resultado).toBe('expirada');
  });

  it('v7 (sem fv): resposta mantém EXATAMENTE o shape antigo (chave extra quebra o schema da Meta)', async () => {
    const { ctx } = ctxFlow({ row: { status: 'open', etapa: 'aguardando_confirmacao' } });
    const reqMeta = encryptFlowRequestComoMeta(publica, {
      action: 'data_exchange',
      flow_token: 'hidrabene:169610420',
      data: { titulo_ticket: 'T', saudacao_ok: 'S' },
    });
    const r = await tratarFlowRequest(ctx as any, reqMeta);
    const resposta: any = decryptFlowResponseComoMeta(reqMeta.aesKey, reqMeta.iv, r.body);
    expect(resposta.screen).toBe('TICKET');
    expect(Object.keys(resposta.data).sort()).toEqual(['saudacao_ok', 'titulo_ticket']);
  });

  it('fora da janela (row closed): CONFIRMADO com oferta_resultado=expirada + evento', async () => {
    const { ctx, db } = ctxFlow({ row: { status: 'closed', etapa: 'sem_resposta' } });
    const reqMeta = encryptFlowRequestComoMeta(publica, {
      action: 'data_exchange',
      flow_token: 'hidrabene:169610420',
      data: { saudacao_ok: 'Tudo certo! ✅' },
    });
    const r = await tratarFlowRequest(ctx as any, reqMeta);
    const resposta: any = decryptFlowResponseComoMeta(reqMeta.aesKey, reqMeta.iv, r.body);
    expect(resposta.screen).toBe('CONFIRMADO');
    expect(resposta.data.oferta_resultado).toBe('expirada');
    expect(db.achou(/UPDATE wa_upsell/).length).toBe(0); // não toca o estado
    expect(db.achou(/INSERT INTO wa_events/).some((c) => JSON.stringify(c.values).includes('ticket_ocultado_fora_da_janela'))).toBe(true);
  });

  it('row inexistente: expirada (nunca mostra ticket de pedido desconhecido)', async () => {
    const { ctx } = ctxFlow({ row: null });
    const reqMeta = encryptFlowRequestComoMeta(publica, {
      action: 'data_exchange',
      flow_token: 'hidrabene:999',
      data: {},
    });
    const r = await tratarFlowRequest(ctx as any, reqMeta);
    const resposta: any = decryptFlowResponseComoMeta(reqMeta.aesKey, reqMeta.iv, r.body);
    expect(resposta.data.oferta_resultado).toBe('expirada');
  });

  it('payload não-decriptável: 421 (a Meta reenta)', async () => {
    const { ctx } = ctxFlow();
    const r = await tratarFlowRequest(ctx as any, {
      encrypted_flow_data: Buffer.from('lixo').toString('base64'),
      encrypted_aes_key: Buffer.from('lixo').toString('base64'),
      initial_vector: Buffer.from('0123456789abcdef').toString('base64'),
    });
    expect(r.status).toBe(421);
  });

  it('sem FLOW_PRIVATE_KEY: 421 + evento de configuração', async () => {
    const { ctx, db } = ctxFlow();
    (ctx as any).cfg = { ...(ctx as any).cfg, FLOW_PRIVATE_KEY: '' };
    const reqMeta = encryptFlowRequestComoMeta(publica, { action: 'ping' });
    const r = await tratarFlowRequest(ctx as any, reqMeta);
    expect(r.status).toBe(421);
    expect(db.achou(/INSERT INTO wa_events/).some((c) => JSON.stringify(c.values).includes('flow_sem_chave_privada'))).toBe(true);
  });
});
