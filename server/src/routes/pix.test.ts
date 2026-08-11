import { describe, expect, it } from 'vitest';
import { classificarUA } from './pix.js';

describe('classificarUA — quem abriu a página do PIX', () => {
  it('navegador de celular é pessoa', () => {
    expect(classificarUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1')).toBe('pessoa');
    expect(classificarUA('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36')).toBe('pessoa');
  });
  it('pré-carregamento do WhatsApp/Meta NÃO é abertura de cliente', () => {
    // Acontece sozinho quando a mensagem com link é enviada — inflava a métrica
    expect(classificarUA('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)')).toBe('preview');
    expect(classificarUA('WhatsApp/2.23.20.0 A')).toBe('preview');
  });
  it('ferramenta de teste é robô', () => {
    expect(classificarUA('curl/8.4.0')).toBe('robo');
    expect(classificarUA('')).toBe('robo');
  });
});
