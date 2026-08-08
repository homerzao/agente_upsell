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
    expect(cfg.WA_UPSELL_PIX_TTL_MIN).toBe(5);
    expect(cfg.WA_UPSELL_CLOSE_MIN).toBe(10);
    expect(cfg.WA_UPSELL_JANELA_MIN).toBe(25); // ERP libera ~28min
    expect(cfg.WA_UPSELL_AUTO_CLOSE_HORAS).toBe(4); // só corrigir_sac
    expect(cfg.OPENAI_MODEL).toBe('gpt-5.6-luna');
  });
  it('exige BACKEND_TOKEN forte', () => {
    expect(() => loadConfig({ ...envMin, BACKEND_TOKEN: 'curto' } as NodeJS.ProcessEnv)).toThrow();
  });
});
