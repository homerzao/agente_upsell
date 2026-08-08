// Seeds idempotentes de boot: config de disparo (linha única) e oferta default.
import type { Db } from '../db/pool.js';
import { COPIES_DEFAULT, OFERTA_DEFAULT } from './copies.js';

// CPF do Jorge: piloto default. Rollout gradual = abrir o filtro no painel.
export const CPF_PILOTO = '04686204194';

export async function seed(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO disparos_config (id, modo, cpf_filtro, rate_por_hora, pausado, amostra_restante)
     VALUES (1, 'test', $1, 0, false, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [[CPF_PILOTO]],
  );
  const temOferta = await db.query('SELECT 1 FROM ofertas LIMIT 1');
  if (!temOferta.rows.length) {
    await db.query(
      `INSERT INTO ofertas (nome, sku_yampi, preco, preco_de, ativo, copies)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [OFERTA_DEFAULT.nome, OFERTA_DEFAULT.sku_yampi, OFERTA_DEFAULT.preco, OFERTA_DEFAULT.preco_de, COPIES_DEFAULT],
    );
  }
  // Sandbox da API de status (casos 900000001..4 do doc do faturamento)
  await seedSandbox(db);
}

export async function seedSandbox(db: Db): Promise<void> {
  const casos: Array<[number, string, string, string]> = [
    [900000001, 'SANDBOX-ABERTO', 'open', 'aguardando_confirmacao'],
    [900000002, 'SANDBOX-RECUSOU', 'closed', 'recusado'],
    [900000003, 'SANDBOX-CORRIGIR', 'open', 'corrigir_sac'],
    [900000004, 'SANDBOX-PAGOU', 'closed', 'pago'],
  ];
  for (const [id, numero, st, et] of casos) {
    await db.query(
      `INSERT INTO wa_upsell (store, order_id, order_number, customer_phone, customer_name, status, etapa)
       VALUES ('sandbox', $1, $2, '5591999999999', 'Cliente Sandbox', $3, $4)
       ON CONFLICT (store, order_id) DO UPDATE SET status=$3, etapa=$4, atualizado_em=now()`,
      [id, numero, st, et],
    );
  }
  await db.query(`DELETE FROM wa_upsell_pagamentos WHERE store='sandbox'`);
  await db.query(
    `INSERT INTO wa_upsell_pagamentos (store, order_id, pagarme_charge_id, pagarme_transaction_id, valor, sku, quantidade, pago_em, payload)
     VALUES ('sandbox', 900000004, 'ch_SANDBOX0001', 'tran_SANDBOX0001', $1, $2, 1, now(), '{}')
     ON CONFLICT (pagarme_charge_id) DO NOTHING`,
    [OFERTA_DEFAULT.preco, OFERTA_DEFAULT.sku_yampi],
  );
}
