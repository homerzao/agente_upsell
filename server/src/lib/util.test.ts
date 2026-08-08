import { describe, expect, it } from 'vitest';
import { carbon, mascararCpf, num, primeiroNome, renderCopy, soDigitos, valorBr } from './util.js';

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
