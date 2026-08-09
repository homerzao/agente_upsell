import { describe, expect, it } from 'vitest';
import { decidirEnvioOperador } from './operador.js';

const base = {
  statusConversa: 'humano',
  modo: 'live' as const,
  fone: '5511987654321',
  foneTeste: '5591992148793',
  temChatwoot: true,
};

describe('decidirEnvioOperador', () => {
  it('conversa do bot: bloqueia (bot e humano não falam junto)', () => {
    const d = decidirEnvioOperador({ ...base, statusConversa: 'bot' });
    expect(d.pode).toBe(false);
    expect(d).toMatchObject({ motivo: 'bot_conduzindo' });
  });

  it('modo test com cliente real: bloqueia (gotcha 24)', () => {
    const d = decidirEnvioOperador({ ...base, modo: 'test' });
    expect(d.pode).toBe(false);
    expect(d).toMatchObject({ motivo: 'modo_test_fone_diferente' });
  });

  it('modo test com o fone de teste: libera (inclusive sem o nono dígito)', () => {
    expect(decidirEnvioOperador({ ...base, modo: 'test', fone: '5591992148793' }).pode).toBe(true);
    expect(decidirEnvioOperador({ ...base, modo: 'test', fone: '559192148793' }).pode).toBe(true);
  });

  it('sem Chatwoot configurado: bloqueia', () => {
    const d = decidirEnvioOperador({ ...base, temChatwoot: false });
    expect(d).toMatchObject({ pode: false, motivo: 'sem_chatwoot' });
  });

  it('assumida + live + chatwoot: libera', () => {
    expect(decidirEnvioOperador(base).pode).toBe(true);
  });
});
