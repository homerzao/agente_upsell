import { describe, expect, it } from 'vitest';
import { COPIES_DEFAULT } from './copies.js';
import { montarTemplateConfirma } from './template.js';

const dados = {
  nome: 'Maria',
  nome_completo: 'Maria da Silva',
  numero: '151722',
  email: 'maria@example.com',
  endereco: 'Rua A, 10, Centro, Belém/PA, CEP 66000-000',
};

describe('montarTemplateConfirma', () => {
  it('monta template com header, body e botão de flow', () => {
    const p: any = montarTemplateConfirma({
      to: '5591992148793',
      templateNome: 'confirma_pedido_up_v4',
      flowToken: 'hidrabene:169610420',
      headerUrl: 'https://cdn/img.jpg',
      copies: COPIES_DEFAULT,
      dados,
    });
    expect(p.type).toBe('template');
    expect(p.template.name).toBe('confirma_pedido_up_v4');
    expect(p.template.language.code).toBe('pt_BR');
    const [header, body, botao] = p.template.components;
    expect(header.parameters[0].image).toEqual({ link: 'https://cdn/img.jpg' });
    expect(body.parameters.map((x: any) => x.text)).toEqual(['Maria', '151722']);
    expect(botao.sub_type).toBe('flow');
    expect(botao.parameters[0].action.flow_token).toBe('hidrabene:169610420');
  });

  it('frases compostas ficam no flow_action_data (bindings puros no flow)', () => {
    const p: any = montarTemplateConfirma({
      to: 'x',
      templateNome: 't',
      flowToken: 'hidrabene:1',
      headerMediaId: '999',
      copies: COPIES_DEFAULT,
      dados,
    });
    const fad = p.template.components[2].parameters[0].action.flow_action_data;
    expect(fad.saudacao).toBe('Olá, Maria! ✨');
    expect(fad.linha_pedido).toContain('#151722');
    expect(fad.linha_nome).toBe('📌 Nome: Maria da Silva');
    expect(fad.linha_email).toBe('📧 E-mail: maria@example.com');
    expect(fad.linha_endereco).toContain('Belém/PA');
    expect(fad.titulo_ticket).toContain('TICKET DOURADO');
    expect(fad.saudacao_ok).toBe('Tudo certo, Maria! ✅');
    // nenhum placeholder vaza
    for (const v of Object.values(fad)) expect(String(v)).not.toMatch(/\{\{/);
  });

  it('sem headerUrl usa media id (que expira ~30d)', () => {
    const p: any = montarTemplateConfirma({
      to: 'x',
      templateNome: 't',
      flowToken: 'hidrabene:1',
      headerMediaId: '4547821698825386',
      copies: COPIES_DEFAULT,
      dados,
    });
    expect(p.template.components[0].parameters[0].image).toEqual({ id: '4547821698825386' });
  });
});
