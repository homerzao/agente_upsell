import { describe, expect, it } from 'vitest';
import { escapeHtml, estadoPagina, renderPaginaNaoEncontrada, renderPaginaPix, type DadosPagina } from './pagina-pix.js';

const daquiA10Min = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();
const ha10Min = () => new Date(Date.now() - 10 * 60 * 1000).toISOString();

const base: DadosPagina = {
  estado: 'vivo',
  token: 'tok_teste',
  nome: 'Maria',
  produto: 'Protetor Solar Facial FPS 90',
  preco: '19,91',
  precoDe: '49,90',
  economia: '29,99',
  descontoPct: '60',
  codigo: '00020101TESTE5204',
  expiraEmIso: daquiA10Min(),
};

describe('estadoPagina', () => {
  it('pago vence tudo', () => {
    expect(estadoPagina({ status: 'closed', etapa: 'pago', pix_codigo: null, pix_expira_em: null } as any)).toBe('pago');
  });
  it('vivo exige open + pix_enviado + código + validade no futuro', () => {
    expect(estadoPagina({ status: 'open', etapa: 'pix_enviado', pix_codigo: 'abc', pix_expira_em: daquiA10Min() } as any)).toBe('vivo');
  });
  it('validade no passado = expirado', () => {
    expect(estadoPagina({ status: 'open', etapa: 'pix_enviado', pix_codigo: 'abc', pix_expira_em: ha10Min() } as any)).toBe('expirado');
  });
  it('qualquer outra etapa = expirado (nunca vaza código)', () => {
    expect(estadoPagina({ status: 'closed', etapa: 'recusado', pix_codigo: 'abc', pix_expira_em: daquiA10Min() } as any)).toBe('expirado');
    expect(estadoPagina({ status: 'open', etapa: 'aguardando_confirmacao', pix_codigo: null, pix_expira_em: null } as any)).toBe('expirado');
  });
});

describe('renderPaginaPix', () => {
  it('vivo: código presente, timer com expira do servidor, botão único', () => {
    const html = renderPaginaPix(base);
    expect(html).toContain('00020101TESTE5204');
    expect(html).toContain(`data-expira="${base.expiraEmIso}"`);
    expect(html).toContain('id="copiarInline"');
    // decisão do Jorge (10/08): SÓ o botão abaixo do código — sem barra fixa
    expect(html).not.toContain('id="copiar"');
    expect(html).toContain('R$ 49,90');
    expect(html).toContain('60% OFF');
  });
  it('pago/expirado: NUNCA renderizam código', () => {
    for (const estado of ['pago', 'expirado'] as const) {
      const html = renderPaginaPix({ ...base, estado, codigo: '', expiraEmIso: '' });
      expect(html).not.toContain('00020101TESTE5204');
      expect(html).toContain(`class="${estado}"`);
    }
  });
  it('escapa HTML em nome e produto (XSS)', () => {
    const html = renderPaginaPix({ ...base, nome: '<script>x</script>', produto: 'FPS "90" <b>' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('FPS &quot;90&quot; &lt;b&gt;');
  });
  it('sem preco_de: não mostra selo nem riscado', () => {
    const html = renderPaginaPix({ ...base, precoDe: '', economia: '', descontoPct: '' });
    expect(html).not.toContain('class="de"');
    expect(html).not.toContain('OFF');
  });
});

describe('escapeHtml / página neutra', () => {
  it('escapa os 5 caracteres', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
  it('token desconhecido: página neutra sem dado nenhum', () => {
    const html = renderPaginaNaoEncontrada();
    expect(html).toContain('noindex');
    expect(html).not.toContain('R$');
  });
});
