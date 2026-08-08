import { describe, expect, it } from 'vitest';
import { montarSystemPrompt } from './contexto.js';
import { TOOL_DEFS } from './tools.js';
import { pedeHumano, processarMensagemCliente, resolverConversa } from './agente.js';
import { FakeDb, configDisparoRow, ctxTeste, rowBase, ofertaBase } from '../../test/fakes.js';
import { COPIES_DEFAULT } from '../copies.js';
import type { WaUpsellRow } from '../tipos.js';

describe('pedeHumano (heurística de handoff)', () => {
  it('detecta pedido explícito', () => {
    expect(pedeHumano('quero falar com um atendente')).toBe(true);
    expect(pedeHumano('me passa pra um humano por favor')).toBe(true);
    expect(pedeHumano('quero falar com alguém')).toBe(true);
  });
  it('não dispara em conversa normal', () => {
    expect(pedeHumano('quero pagar o pix')).toBe(false);
    expect(pedeHumano('meu endereço está errado')).toBe(false);
  });
});

describe('montarSystemPrompt (guardrails)', () => {
  const contexto = {
    row: rowBase({ etapa: 'pix_enviado' }) as unknown as WaUpsellRow,
    oferta: { ...ofertaBase(), preco: 49.91, preco_de: 149.9, copies: COPIES_DEFAULT } as any,
    pedido: {
      numero: '151722',
      status: 'paid',
      itens: [{ titulo: 'Sabonete', qtd: 2, preco: 39.9 }],
      total: 79.8,
      endereco: 'Rua A, 10, Belém/PA',
      rastreio: null,
    },
    pagamento: null,
    correcoesPendentes: 1,
  };

  it('inclui os guardrails inegociáveis', () => {
    const p = montarSystemPrompt(contexto);
    expect(p).toContain('NUNCA invente preço');
    expect(p).toContain('NUNCA prometa reembolso');
    expect(p).toContain('encaminhar_humano');
    expect(p).toContain('aprovação');
    expect(p).toContain('registrar_correcao');
  });

  it('inclui contexto do pedido, funil e oferta', () => {
    const p = montarSystemPrompt(contexto);
    expect(p).toContain('#151722');
    expect(p).toContain('Sabonete');
    expect(p).toContain('pix_enviado');
    expect(p).toContain('49,91');
    expect(p).toContain('SKU 2133823');
    expect(p).toContain('Correções aguardando aprovação: 1');
  });

  it('NUNCA contém o CPF completo', () => {
    const p = montarSystemPrompt(contexto);
    expect(p).not.toContain('04686204194');
    expect(p).toContain('046***94');
  });
});

describe('tools do agente', () => {
  it('expõe exatamente as 5 tools da spec', () => {
    expect(TOOL_DEFS.map((t) => t.function.name).sort()).toEqual([
      'consultar_pedido', 'encaminhar_humano', 'reenviar_pix', 'registrar_correcao', 'status_oferta',
    ]);
  });
});

function dbAgente(over: { conversaStatus?: string; modo?: string } = {}) {
  const db = new FakeDb();
  const mensagens: any[] = [];
  db.on(/SELECT \* FROM disparos_config/, () => [configDisparoRow({ modo: over.modo ?? 'live' })]);
  db.on(/SELECT \* FROM conversas WHERE chatwoot_conversation_id/, () => [
    { id: 9, wa_upsell_id: 1, chatwoot_conversation_id: 555, status: over.conversaStatus ?? 'bot' },
  ]);
  db.on(/SELECT \* FROM wa_upsell WHERE id/, () => [rowBase()]);
  db.on(/INSERT INTO mensagens_ia/, (values) => {
    mensagens.push(values);
    return [];
  });
  db.on(/SELECT direcao, texto FROM mensagens_ia/, () => []);
  db.on(/SELECT payload FROM pedidos_status/, () => []);
  db.on(/SELECT valor, pago_em FROM wa_upsell_pagamentos/, () => []);
  db.on(/COUNT\(\*\)::int AS n FROM correcoes/, () => [{ n: 0 }]);
  db.on(/SELECT \* FROM ofertas WHERE id/, () => [ofertaBase({ copies: COPIES_DEFAULT })]);
  return { db, mensagens };
}

function chatwootFake() {
  const enviadas: Array<{ convId: number; content: string; privada: boolean }> = [];
  return {
    enviadas,
    async enviarMensagem(convId: number, content: string, privada = false) {
      enviadas.push({ convId, content, privada });
      return {};
    },
    async setLabels() { return {}; },
    async atribuirTime() { return {}; },
    async desatribuir() { return {}; },
  };
}

describe('processarMensagemCliente', () => {
  it('conversa em modo humano: bot fica quieto (só loga a mensagem)', async () => {
    const { db, mensagens } = dbAgente({ conversaStatus: 'humano' });
    const cw = chatwootFake();
    const ctx: any = { ...ctxTeste({ db }), chatwoot: cw, openai: null };
    await processarMensagemCliente(ctx, 555, '5511987654321', 'oi');
    expect(mensagens.length).toBe(1); // logou o incoming
    expect(cw.enviadas.length).toBe(0);
  });

  it('cliente pede humano: handoff imediato + resposta cordial', async () => {
    const { db } = dbAgente();
    const cw = chatwootFake();
    const ctx: any = { ...ctxTeste({ db }), chatwoot: cw, openai: null };
    await processarMensagemCliente(ctx, 555, '5511987654321', 'quero falar com um atendente');
    expect(db.achou(/UPDATE conversas SET status='humano'/).length).toBe(1);
    expect(cw.enviadas.some((m) => m.content.includes('te passando'))).toBe(true);
  });

  it('sem OPENAI_API_KEY: handoff (nunca deixa o cliente sem resposta de rota)', async () => {
    const { db } = dbAgente();
    const cw = chatwootFake();
    const ctx: any = { ...ctxTeste({ db }), chatwoot: cw, openai: null };
    await processarMensagemCliente(ctx, 555, '5511987654321', 'qual o status do meu pedido?');
    expect(db.achou(/UPDATE conversas SET status='humano'/).length).toBe(1);
  });

  it('modelo responde: envia pelo Chatwoot e loga com prompt_hash/tokens/custo', async () => {
    const { db, mensagens } = dbAgente();
    const cw = chatwootFake();
    const openai = {
      async chat() {
        return {
          message: { role: 'assistant', content: 'Seu pedido está a caminho! ✅' },
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        };
      },
      custo: () => 0.001,
    };
    const ctx: any = { ...ctxTeste({ db }), chatwoot: cw, openai };
    ctx.cfg = { ...ctx.cfg, OPENAI_API_KEY: 'sk-teste' };
    await processarMensagemCliente(ctx, 555, '5511987654321', 'cadê meu pedido?');
    expect(cw.enviadas[0].content).toContain('a caminho');
    const out = mensagens.find((m) => m[1] === 'out');
    expect(out).toBeTruthy();
    expect(out![3]).toMatch(/^[0-9a-f]{64}$/); // prompt_hash
    expect(out![5]).toBe(120); // tokens
  });

  it('modelo chama encaminhar_humano: transfere e não responde sozinho', async () => {
    const { db } = dbAgente();
    const cw = chatwootFake();
    let chamadas = 0;
    const openai = {
      async chat() {
        chamadas++;
        if (chamadas === 1) {
          return {
            message: {
              role: 'assistant', content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'encaminhar_humano', arguments: '{"motivo":"reembolso","resumo":"cliente quer reembolso"}' } }],
            },
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        }
        return { message: { role: 'assistant', content: null }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      },
      custo: () => 0,
    };
    const ctx: any = { ...ctxTeste({ db }), chatwoot: cw, openai };
    ctx.cfg = { ...ctx.cfg, OPENAI_API_KEY: 'sk-teste' };
    await processarMensagemCliente(ctx, 555, '5511987654321', 'quero reembolso');
    expect(db.achou(/UPDATE conversas SET status='humano'/).length).toBe(1);
  });
});

describe('modo test (gotcha 24)', () => {
  it('bot fica MUDO com cliente real em modo test (só o fone de teste conversa)', async () => {
    const { db, mensagens } = dbAgente({ modo: 'test' });
    const cw = chatwootFake();
    const openai = {
      async chat() {
        throw new Error('não deveria chamar o modelo');
      },
      custo: () => 0,
    };
    const ctx: any = { ...ctxTeste({ db }), chatwoot: cw, openai };
    ctx.cfg = { ...ctx.cfg, OPENAI_API_KEY: 'sk-teste' };
    await processarMensagemCliente(ctx, 555, '5511987654321', 'oi, quero a oferta');
    expect(mensagens.length).toBe(1); // loga o incoming
    expect(cw.enviadas.length).toBe(0); // mas NÃO responde cliente real
  });

  it('fone de teste conversa normalmente em modo test', async () => {
    const { db } = dbAgente({ modo: 'test' });
    const cw = chatwootFake();
    const openai = {
      async chat() {
        return {
          message: { role: 'assistant', content: 'Oi, Jorge! ✅' },
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
      custo: () => 0,
    };
    const ctx: any = { ...ctxTeste({ db }), chatwoot: cw, openai };
    ctx.cfg = { ...ctx.cfg, OPENAI_API_KEY: 'sk-teste' };
    await processarMensagemCliente(ctx, 555, '5591992148793', 'teste');
    expect(cw.enviadas.length).toBe(1);
  });
});

describe('resolverConversa', () => {
  it('sem conversa e sem row pelo fone: não é nossa (null)', async () => {
    const db = new FakeDb();
    db.on(/SELECT \* FROM conversas/, () => []);
    db.on(/SELECT \* FROM wa_upsell WHERE customer_phone/, () => []);
    const ctx: any = { ...ctxTeste({ db }), openai: null };
    expect(await resolverConversa(ctx, 1, '5511900000000')).toBeNull();
  });

  it('fallback: liga a conversa à row mais recente do fone SÓ se entrou no funil', async () => {
    const db = new FakeDb();
    db.on(/SELECT \* FROM conversas WHERE chatwoot_conversation_id/, () => []);
    db.on(/SELECT \* FROM wa_upsell WHERE customer_phone/, (_v, text) => {
      // fora_do_fluxo é SAC comum — o bot não sequestra a conversa
      expect(text).toContain("etapa <> 'fora_do_fluxo'");
      expect(text).toContain('disparo_status IS NOT NULL');
      return [rowBase()];
    });
    db.on(/INSERT INTO conversas/, () => [{ id: 42, wa_upsell_id: 1, chatwoot_conversation_id: 1, status: 'bot' }]);
    const ctx: any = { ...ctxTeste({ db }), openai: null };
    const r = await resolverConversa(ctx, 1, '5511987654321');
    expect(r?.conversa.id).toBe(42);
    expect(r?.row.order_id).toBe(169610420);
  });
});
