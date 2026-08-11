import { describe, expect, it } from 'vitest';
import { derivarTokenWebhook, loadConfig } from './config.js';

const envMin = {
  DATABASE_URL: 'postgres://x',
  BACKEND_TOKEN: 'token-mestre-de-teste-1234567890',
  SESSION_SECRET: 'segredo-sessao-de-teste-123456',
} as NodeJS.ProcessEnv;

describe('derivarTokenWebhook', () => {
  it('é determinístico e tem 32 chars hex', () => {
    const t = derivarTokenWebhook('abc', 'yampi');
    expect(t).toBe(derivarTokenWebhook('abc', 'yampi'));
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });
  it('difere por origem e por token', () => {
    expect(derivarTokenWebhook('abc', 'yampi')).not.toBe(derivarTokenWebhook('abc', 'pagarme'));
    expect(derivarTokenWebhook('abc', 'yampi')).not.toBe(derivarTokenWebhook('outro', 'yampi'));
  });
});

describe('loadConfig', () => {
  it('deriva os 3 tokens de webhook', () => {
    const cfg = loadConfig(envMin);
    expect(cfg.webhookTokenYampi).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set([cfg.webhookTokenYampi, cfg.webhookTokenPagarme, cfg.webhookTokenChatwoot]).size).toBe(3);
  });
  it('defaults operacionais seguros (test + números validados)', () => {
    const cfg = loadConfig(envMin);
    expect(cfg.WA_FONE_TESTE).toBe('5591992148793'); // fone do Jorge
    expect(cfg.WA_UPSELL_TEMPLATE_CONFIRMA).toBe('confirma_pedido_up');
    expect(cfg.WA_UPSELL_FLOW_ID).toBe('3548925675262517'); // v6 (data_exchange)
    // O cliente vê SEMPRE o mesmo número (aceite, relógio da página e conta do
    // lembrete): TTL real − margem. A margem é a gordura invisível de quem
    // paga com o contador zerando (Jorge, 10/08). Fechamento vem depois de tudo.
    expect(cfg.WA_UPSELL_PIX_TTL_MIN).toBe(20);
    expect(cfg.WA_UPSELL_PIX_MARGEM_MIN).toBe(10);
    expect(cfg.WA_UPSELL_PIX_PRAZO_ANUNCIADO_MIN).toBe(10); // decisão do Jorge
    expect(cfg.WA_UPSELL_CLOSE_MIN).toBe(21);
    // INVARIANTE: anunciado = TTL − margem. Se alguém mexer num sem o outro,
    // a mensagem e o relógio da página passam a dizer coisas diferentes.
    expect(cfg.WA_UPSELL_PIX_PRAZO_ANUNCIADO_MIN).toBe(cfg.WA_UPSELL_PIX_TTL_MIN - cfg.WA_UPSELL_PIX_MARGEM_MIN);
    expect(cfg.WA_UPSELL_CLOSE_MIN).toBeGreaterThan(cfg.WA_UPSELL_PIX_TTL_MIN);
    // o lembrete tem que cair ANTES do prazo anunciado, senão não é lembrete
    expect(cfg.WA_UPSELL_LEMBRETE_PIX_APOS_MIN).toBeLessThan(cfg.WA_UPSELL_PIX_PRAZO_ANUNCIADO_MIN);
    expect(cfg.WA_UPSELL_JANELA_MIN).toBe(25); // ERP libera ~28min
    expect(cfg.WA_UPSELL_AUTO_CLOSE_HORAS).toBe(4); // só corrigir_sac
    expect(cfg.OPENAI_MODEL).toBe('gpt-5.6-luna');
  });
  it('exige BACKEND_TOKEN forte', () => {
    expect(() => loadConfig({ ...envMin, BACKEND_TOKEN: 'curto' } as NodeJS.ProcessEnv)).toThrow();
  });
});
