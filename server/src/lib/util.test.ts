import { describe, expect, it } from 'vitest';
import { carbon, foneBr, mascararCpf, mesmoFone, num, primeiroNome, renderCopy, soDigitos, valorBr } from './util.js';

// O WhatsApp manda o mesmo assinante ora COM ora SEM o nono dígito (Jorge, 09/08:
// "as vezes vem com 9 as vezes sem"). Todo match de telefone precisa aguentar isso.
describe('mesmoFone (nono dígito)', () => {
  it('casa com e sem o nono dígito, nos dois sentidos', () => {
    expect(mesmoFone('559192148793', '5591992148793')).toBe(true); // Meta sem 9 x Yampi com 9
    expect(mesmoFone('5591992148793', '559192148793')).toBe(true); // invertido
    expect(mesmoFone('91992148793', '559192148793')).toBe(true); // nacional x com DDI
    expect(mesmoFone('+55 (91) 99214-8793', '559192148793')).toBe(true); // formatado
  });
  it('não casa DDD diferente nem número diferente', () => {
    expect(mesmoFone('5511992148793', '5591992148793')).toBe(false); // mesmo final, DDD outro
    expect(mesmoFone('5591992148794', '5591992148793')).toBe(false);
    expect(mesmoFone('', '5591992148793')).toBe(false);
  });
  it('foneBr põe DDI 55 só no formato nacional', () => {
    expect(foneBr('91992148793')).toBe('5591992148793');
    expect(foneBr('5591992148793')).toBe('5591992148793');
    expect(foneBr('559192148793')).toBe('559192148793');
  });
});

describe('soDigitos', () => {
  it('remove tudo que não é dígito', () => {
    expect(soDigitos('+55 (91) 99214-8793')).toBe('5591992148793');
    expect(soDigitos('046.862.041-94')).toBe('04686204194');
    expect(soDigitos(null)).toBe('');
    expect(soDigitos(undefined)).toBe('');
  });
});

describe('primeiroNome', () => {
  it('extrai o primeiro nome', () => {
    expect(primeiroNome('Maria da Silva')).toBe('Maria');
    expect(primeiroNome('  Jorge  Luis ')).toBe('Jorge');
  });
  it('cai pra "cliente" quando vazio', () => {
    expect(primeiroNome('')).toBe('cliente');
    expect(primeiroNome(null)).toBe('cliente');
  });
});

describe('carbon (datas Yampi)', () => {
  it('normaliza objeto Carbon {date, timezone} para ISO -03:00', () => {
    expect(carbon({ date: '2026-08-08 14:30:00.000000', timezone: 'America/Sao_Paulo' })).toBe(
      '2026-08-08T14:30:00-03:00',
    );
  });
  it('normaliza string direta', () => {
    expect(carbon('2026-08-08 14:30:00')).toBe('2026-08-08T14:30:00-03:00');
  });
  it('null/vazio vira null', () => {
    expect(carbon(null)).toBeNull();
    expect(carbon(undefined)).toBeNull();
    expect(carbon({ date: null })).toBeNull();
  });
});

describe('num', () => {
  it('converte e preserva null', () => {
    expect(num('49.91')).toBe(49.91);
    expect(num('')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(0)).toBe(0);
  });
});

describe('mascararCpf (guardrail: nunca ecoar CPF completo)', () => {
  it('mascara o miolo', () => {
    expect(mascararCpf('04686204194')).toBe('046***94');
    expect(mascararCpf('046.862.041-94')).toBe('046***94');
  });
  it('curto demais vira ***', () => {
    expect(mascararCpf('123')).toBe('***');
    expect(mascararCpf(null)).toBe('***');
  });
  it('nunca contém o CPF completo', () => {
    expect(mascararCpf('04686204194')).not.toContain('04686204194');
  });
});

describe('renderCopy', () => {
  it('substitui placeholders', () => {
    expect(renderCopy('Olá, {{nome}}! Pedido #{{numero}}.', { nome: 'Maria', numero: '123' })).toBe(
      'Olá, Maria! Pedido #123.',
    );
  });
  it('placeholder sem valor vira vazio (nunca vaza {{}})', () => {
    expect(renderCopy('Oi {{nome}}', {})).toBe('Oi ');
    expect(renderCopy('Oi {{nome}}', { nome: null })).toBe('Oi ');
  });
  it('aceita números', () => {
    expect(renderCopy('vale {{minutos}} min', { minutos: 5 })).toBe('vale 5 min');
  });
});

describe('valorBr', () => {
  it('formata com vírgula', () => {
    expect(valorBr(49.91)).toBe('49,91');
    expect(valorBr(150)).toBe('150,00');
  });
});
