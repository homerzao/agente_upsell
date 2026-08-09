// Fakes de teste: DB (pattern-match de SQL), Redis em memória e integrações.
import { loadConfig, type Config } from '../config.js';
import type { FunilCtx, RedisLike } from '../domain/funil.js';

export class FakeDb {
  calls: Array<{ text: string; values: unknown[] }> = [];
  private handlers: Array<{ re: RegExp; fn: (values: unknown[], text: string) => any[] | undefined }> = [];

  on(re: RegExp, fn: (values: unknown[], text: string) => any[] | undefined): this {
    this.handlers.push({ re, fn });
    return this;
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: any[]; rowCount: number | null }> {
    this.calls.push({ text, values });
    for (const h of this.handlers) {
      if (h.re.test(text)) {
        const rows = h.fn(values, text) ?? [];
        return { rows, rowCount: rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  }

  achou(re: RegExp): Array<{ text: string; values: unknown[] }> {
    return this.calls.filter((c) => re.test(c.text));
  }
}

export class FakeRedis implements RedisLike {
  listas = new Map<string, string[]>();
  valores = new Map<string, string>();

  async rpush(key: string, val: string) {
    const l = this.listas.get(key) ?? [];
    l.push(val);
    this.listas.set(key, l);
    return l.length;
  }
  async lpush(key: string, val: string) {
    const l = this.listas.get(key) ?? [];
    l.unshift(val);
    this.listas.set(key, l);
    return l.length;
  }
  async lpop(key: string) {
    const l = this.listas.get(key) ?? [];
    return l.shift() ?? null;
  }
  async llen(key: string) {
    return (this.listas.get(key) ?? []).length;
  }
  async incr(key: string) {
    const v = Number(this.valores.get(key) ?? 0) + 1;
    this.valores.set(key, String(v));
    return v;
  }
  async expire() {
    return 1;
  }
  async get(key: string) {
    return this.valores.get(key) ?? null;
  }
  // suporta set(key, val, 'EX', ttl, 'NX') como o ioredis (dedup de wamid)
  async set(key: string, val: string, ...args: Array<string | number>) {
    if (args.includes('NX') && this.valores.has(key)) return null;
    this.valores.set(key, val);
    return 'OK';
  }
  async del(key: string) {
    return this.valores.delete(key) ? 1 : 0;
  }
}

export function fakeMeta() {
  const enviadas: any[] = [];
  let falharProximo: string | null = null;
  return {
    enviadas,
    falhar(msg: string) {
      falharProximo = msg;
    },
    async waSendRaw(payload: Record<string, unknown>) {
      if (falharProximo) {
        const m = falharProximo;
        falharProximo = null;
        throw new Error(m);
      }
      enviadas.push(payload);
      return { messages: [{ id: `wamid.${enviadas.length}` }] };
    },
    async enviarTexto(to: string, body: string) {
      return this.waSendRaw({ to, type: 'text', text: { body } });
    },
    validarAssinatura() {
      return true;
    },
  };
}

export function fakePagarme(over: Partial<{ chargeId: string | null; codigo: string; falhaCriar: string }> = {}) {
  const canceladas: string[] = [];
  return {
    canceladas,
    async req() {
      return {};
    },
    async criarPix() {
      if (over.falhaCriar) throw new Error(over.falhaCriar);
      return { chargeId: over.chargeId === undefined ? 'ch_teste1' : over.chargeId, codigo: over.codigo ?? 'PIXCODE123', raw: {} };
    },
    async getCharge() {
      return {};
    },
    async cancelarCharge(id: string) {
      canceladas.push(id);
      return { ok: false, esperado412: true };
    },
  };
}

export function fakeYampi(pedido: any = null) {
  const comments: Array<{ orderId: number | string; texto: string }> = [];
  const puts: any[] = [];
  return {
    comments,
    puts,
    async req() {
      return {};
    },
    async getOrder() {
      if (!pedido) throw new Error('yampi GET 404');
      return pedido;
    },
    async getCustomer() {
      return pedido?.customer?.data ?? {};
    },
    async putOrder(id: any, body: any) {
      puts.push({ recurso: 'order', id, body });
      return {};
    },
    async putCustomer(id: any, body: any) {
      puts.push({ recurso: 'customer', id, body });
      return {};
    },
    async getOrderAddresses() {
      return pedido?.enderecos ?? [];
    },
    async putOrderAddress(orderId: any, id: any, body: any) {
      puts.push({ recurso: 'order_address', orderId, id, body });
      return {};
    },
    async comment(orderId: number | string, texto: string) {
      comments.push({ orderId, texto });
      return {};
    },
    async listarWebhooks() {
      return [];
    },
    async criarWebhookAtivo() {
      return {};
    },
  };
}

export function cfgTeste(extra: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgres://teste',
    BACKEND_TOKEN: 'token-mestre-de-teste-1234567890',
    SESSION_SECRET: 'segredo-sessao-de-teste-123456',
    PAGARME_SECRET_KEY: 'sk_teste',
    METAWA_TOKEN: 'meta-token',
    METAWA_PHONE_ID: '123',
    ...extra,
  } as NodeJS.ProcessEnv);
}

export function ctxTeste(over: Partial<FunilCtx> & { db?: FakeDb } = {}): FunilCtx & {
  db: FakeDb;
  redis: FakeRedis;
  metaFake: ReturnType<typeof fakeMeta>;
} {
  const db = over.db ?? new FakeDb();
  const redis = (over.redis as FakeRedis) ?? new FakeRedis();
  const meta = fakeMeta();
  return {
    db: db as any,
    redis,
    cfg: over.cfg ?? cfgTeste(),
    meta: (over.meta as any) ?? (meta as any),
    yampi: (over.yampi as any) ?? (fakeYampi() as any),
    pagarme: (over.pagarme as any) ?? (fakePagarme() as any),
    chatwoot: (over.chatwoot as any) ?? null,
    metaFake: meta,
  } as any;
}

export const rowBase = (over: Record<string, unknown> = {}) => ({
  id: 1,
  store: 'hidrabene',
  order_id: 169610420,
  order_number: '1517221321295822',
  customer_phone: '5511987654321',
  customer_name: 'Maria da Silva',
  customer_cpf: '04686204194',
  customer_email: 'maria@example.com',
  status: 'open',
  etapa: 'aguardando_confirmacao',
  oferta_id: 1,
  disparo_status: 'enviado',
  template_msg_id: 'wamid.tpl',
  pix_charge_id: null,
  pix_codigo: null,
  pix_enviado_em: null,
  pix_expira_em: null,
  criado_em: new Date().toISOString(),
  atualizado_em: new Date().toISOString(),
  ...over,
});

export const ofertaBase = (over: Record<string, unknown> = {}) => ({
  id: 1,
  nome: 'Kit Clareador Completo',
  sku_yampi: '2133823',
  preco: '49.91',
  preco_de: '149.90',
  ativo: true,
  copies: {},
  ...over,
});

export const configDisparoRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  modo: 'test',
  cpf_filtro: ['04686204194'],
  rate_por_hora: 0,
  pausado: false,
  amostra_restante: null,
  metodos_permitidos: [], // [] = todos (testes antigos não olham método)
  ...over,
});
