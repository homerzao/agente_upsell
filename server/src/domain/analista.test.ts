import { describe, expect, it } from 'vitest';
import { montarPromptAnalista, parseDecisao, preChecagem, REGRAS_ANALISTA_PADRAO } from './analista.js';

describe('preChecagem (guardas de código, sem LLM)', () => {
  it('barra correção sem mudança real (caso Jacqueline: 4 duplicatas no piloto)', () => {
    const iguais = { endereco: { complement: 'Casa' } };
    expect(preChecagem(iguais, { endereco: { complement: 'Casa' } })).toMatch(/sem mudança real/);
  });

  it('barra qualquer toque em cidade/UF/CEP — mudam o frete', () => {
    const antes = { endereco: { city: 'Canoas', state: 'RS', zip_code: '92200030', number: '146' } };
    expect(preChecagem(antes, { endereco: { ...antes.endereco, city: 'Esteio' } })).toMatch(/city/);
    expect(preChecagem(antes, { endereco: { ...antes.endereco, state: 'SC' } })).toMatch(/state/);
    expect(preChecagem(antes, { endereco: { ...antes.endereco, zip_code: '92200031' } })).toMatch(/zip_code/);
  });

  it('deixa passar o caso normal (número corrigido)', () => {
    const antes = { endereco: { city: 'Canoas', state: 'RS', zip_code: '92200030', number: '146' } };
    expect(preChecagem(antes, { endereco: { ...antes.endereco, number: '147' } })).toBeNull();
  });
});

describe('parseDecisao (defensivo: fora do contrato = deixar)', () => {
  it('aceita o contrato', () => {
    expect(parseDecisao('{"decisao":"aprovar","motivo":"typo de e-mail"}')).toEqual({
      decisao: 'aprovar', motivo: 'typo de e-mail',
    });
  });

  it('JSON dentro de texto/markdown ainda parseia', () => {
    const d = parseDecisao('Claro! Aqui está:\n```json\n{"decisao":"deixar","motivo":"instrução de entrega"}\n```');
    expect(d.decisao).toBe('deixar');
  });

  it('qualquer decisao que não seja aprovar vira deixar', () => {
    expect(parseDecisao('{"decisao":"rejeitar","motivo":"x"}').decisao).toBe('deixar');
    expect(parseDecisao('{"decisao":"APROVAR","motivo":"x"}').decisao).toBe('deixar');
  });

  it('lixo/vazio vira deixar', () => {
    expect(parseDecisao('não sei').decisao).toBe('deixar');
    expect(parseDecisao(null).decisao).toBe('deixar');
    expect(parseDecisao('{quebrado').decisao).toBe('deixar');
  });
});

describe('montarPromptAnalista', () => {
  it('regras no system, antes/depois no user', () => {
    const msgs = montarPromptAnalista(REGRAS_ANALISTA_PADRAO, {
      campos_antes: { email: 'a@gmil.com' },
      campos_depois: { email: 'a@gmail.com' },
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('analista de aprovações');
    expect(msgs[1].content).toContain('a@gmil.com');
    expect(msgs[1].content).toContain('a@gmail.com');
  });

  it('as regras padrão carregam os aprendizados reais (Fator 70, instrução de entrega, na dúvida deixa)', () => {
    expect(REGRAS_ANALISTA_PADRAO).toContain('Fator 70');
    expect(REGRAS_ANALISTA_PADRAO).toContain('INSTRUÇÃO DE ENTREGA');
    expect(REGRAS_ANALISTA_PADRAO).toContain('Na dúvida, deixe');
  });
});
