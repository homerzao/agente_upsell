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
  } else {
    // Backfill de copies NOVAS (ex.: msg_despedida) em ofertas existentes:
    // default primeiro, existente vence — texto editado no painel não é tocado.
    await db.query(`UPDATE ofertas SET copies = $1::jsonb || copies`, [COPIES_DEFAULT]);
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
    // Multi-oferta (10/08): o dev do faturamento precisa de um caso com SKU
    // DIFERENTE do kit, senão ele testa achando que o sku é sempre 2133823.
    [900000005, 'SANDBOX-PAGOU-FPS90', 'closed', 'pago'],
  ];
  for (const [id, numero, st, et] of casos) {
    await db.query(
      `INSERT INTO wa_upsell (store, order_id, order_number, customer_phone, customer_name, status, etapa)
       VALUES ('sandbox', $1, $2, '5591999999999', 'Cliente Sandbox', $3, $4)
       ON CONFLICT (store, order_id) DO UPDATE SET status=$3, etapa=$4,
         criado_em=now(), atualizado_em=now()`, // gotcha 20: reabertura reseta criado_em
      [id, numero, st, et],
    );
  }
  // Este DELETE é o motivo de o caso do FPS 90 ter sumido em 10/08: ele roda a
  // CADA boot e apagava tudo, mas só o pagamento do 900000004 era recriado.
  // Todo caso pago do sandbox tem que ser recriado logo abaixo.
  await db.query(`DELETE FROM wa_upsell_pagamentos WHERE store='sandbox'`);
  const pagos: Array<[number, string, string, number, string]> = [
    [900000004, 'ch_SANDBOX0001', 'tran_SANDBOX0001', OFERTA_DEFAULT.preco, OFERTA_DEFAULT.sku_yampi],
    [900000005, 'ch_SANDBOX_FPS90', 'tran_SANDBOX_FPS90', 19.91, '2046'],
  ];
  for (const [id, charge, tran, valor, sku] of pagos) {
    await db.query(
      `INSERT INTO wa_upsell_pagamentos (store, order_id, pagarme_charge_id, pagarme_transaction_id, valor, sku, quantidade, pago_em, payload)
       VALUES ('sandbox', $1, $2, $3, $4, $5, 1, now(), '{}')
       ON CONFLICT (pagarme_charge_id) DO NOTHING`,
      [id, charge, tran, valor, sku],
    );
  }
}
