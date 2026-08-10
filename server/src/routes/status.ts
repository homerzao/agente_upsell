// API de status pro sistema de faturamento — CONTRATO CONGELADO (já integrado
// por outro dev; ver docs/api-wa-upsell-faturamento.md do agente_ecom).
// Token SÓ-LEITURA (STATUS_TOKEN); o mestre também é aceito para uso interno.
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../plugins/auth.js';
import type { FunilCtx } from '../domain/funil.js';

// Formata a resposta do contrato a partir das rows — puro, coberto por teste.
export function formatarStatus(orderId: number, row: any | null, pagamento: any | null): Record<string, unknown> {
  // Pedido inexistente responde closed/fora_do_fluxo (200, NUNCA 404):
  // o faturamento não pode travar em pedido fora do fluxo.
  if (!row) return { order_id: orderId, status: 'closed', etapa: 'fora_do_fluxo', pagamento: null };
  return {
    order_id: orderId,
    order_number: row.order_number,
    status: row.status,
    etapa: row.etapa,
    atualizado_em: row.atualizado_em,
    pagamento: pagamento
      ? {
          pagarme_charge_id: pagamento.pagarme_charge_id,
          pagarme_transaction_id: pagamento.pagarme_transaction_id,
          valor: Number(pagamento.valor).toFixed(2),
          sku: pagamento.sku,
          // NOME do produto junto do SKU (Jorge, 10/08: "como o sistema vai
          // saber o produto lá?"). Campo ADICIONADO, nenhum removido — quem já
          // integrou continua funcionando. É informativo: a decisão de qual
          // item lançar continua sendo pelo `sku`.
          produto: pagamento.produto ?? null,
          quantidade: pagamento.quantidade,
          pago_em: pagamento.pago_em,
        }
      : null,
  };
}

export function statusRoutes(app: FastifyInstance, ctx: FunilCtx, auth: Auth): void {
  app.get('/wa-upsell/status/:orderId', async (req, reply) => {
    if (!auth.ehBearerMaster(req) && !auth.ehBearerStatus(req)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const orderId = Number((req.params as any).orderId);
    const store = String((req.query as any).store ?? 'hidrabene');
    const r = await ctx.db.query('SELECT * FROM wa_upsell WHERE store=$1 AND order_id=$2', [store, orderId]);
    const row = r.rows[0] ?? null;
    let pagamento: any = null;
    if (row) {
      // O nome do produto vem da OFERTA que o cliente recebeu (join pelo SKU):
      // é o mesmo texto que o painel mostra, então o dev confere de olho.
      const p = await ctx.db.query(
        `SELECT pg.pagarme_charge_id, pg.pagarme_transaction_id, pg.valor, pg.sku,
                pg.quantidade, pg.pago_em, o.nome AS produto
           FROM wa_upsell_pagamentos pg
           LEFT JOIN ofertas o ON o.sku_yampi = pg.sku
          WHERE pg.store=$1 AND pg.order_id=$2 ORDER BY pg.id DESC LIMIT 1`,
        [store, orderId],
      );
      pagamento = p.rows[0] ?? null;
    }
    return formatarStatus(orderId, row, pagamento);
  });
}
