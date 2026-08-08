// Pagar.me v5.
// GOTCHAS: PIX exige customer.document (senão charge nasce failed);
// qr_code nem sempre vem no POST /orders (transação async) -> refetch até 3× com 2s;
// charge PIX pending NÃO cancela (HTTP 412) — o QR expira sozinho pelo expires_in.
import { sleep } from '../lib/util.js';

export type PagarmeService = ReturnType<typeof criarPagarme>;

type FetchFn = typeof fetch;

export function criarPagarme(
  cfg: { PAGARME_SECRET_KEY: string },
  fetchFn: FetchFn = fetch,
  sleepFn: (ms: number) => Promise<void> = sleep,
) {
  async function req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetchFn(`https://api.pagar.me/core/v5${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${cfg.PAGARME_SECRET_KEY}:`).toString('base64')}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`pagarme ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }

  type PixParams = {
    code: string;
    nome: string;
    email: string;
    cpf: string; // obrigatório — validar ANTES de chamar
    fone: string;
    descricao: string;
    valorCents: number;
    sku: string;
    expiresInSeg: number;
  };

  // Cria o pedido PIX e garante o qr_code (refetch da charge se vier async).
  async function criarPix(p: PixParams): Promise<{ chargeId: string | null; codigo: string; raw: any }> {
    const pm = await req('POST', '/orders', {
      code: p.code,
      customer: {
        name: p.nome,
        email: p.email,
        document: p.cpf,
        document_type: 'CPF',
        type: 'individual',
        phones: {
          mobile_phone: {
            country_code: '55',
            area_code: p.fone.slice(2, 4) || '11',
            number: p.fone.slice(4) || '999999999',
          },
        },
      },
      items: [{ amount: p.valorCents, description: p.descricao, quantity: 1, code: p.sku }],
      payments: [{ payment_method: 'pix', pix: { expires_in: p.expiresInSeg } }],
    });
    const charge = pm.charges?.[0];
    let codigo: string = charge?.last_transaction?.qr_code ?? '';
    for (let t = 0; !codigo && t < 3 && charge?.id; t++) {
      await sleepFn(2000);
      const ch = await req('GET', `/charges/${charge.id}`).catch(() => null);
      codigo = ch?.last_transaction?.qr_code ?? '';
    }
    return { chargeId: charge?.id ?? null, codigo, raw: pm };
  }

  const getCharge = (id: string) => req('GET', `/charges/${id}`);

  // 412 = charge pending não cancelável: ESPERADO, não é erro.
  async function cancelarCharge(id: string): Promise<{ ok: boolean; esperado412: boolean }> {
    try {
      await req('DELETE', `/charges/${id}`);
      return { ok: true, esperado412: false };
    } catch (e) {
      if (String((e as Error).message).includes('412')) return { ok: false, esperado412: true };
      throw e;
    }
  }

  return { req, criarPix, getCharge, cancelarCharge };
}
