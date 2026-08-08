#!/usr/bin/env node
// Importação ONE-SHOT do histórico do agente_ecom -> agente_upsell (cutover §5.6).
//
// Por que é obrigatório ANTES de trocar as pontas: um pedido `pago` no banco velho
// consultado no banco novo responderia closed/fora_do_fluxo SEM pagamento -> o
// faturamento faturaria SEM adicionar o SKU pago.
//
// Uso (no servidor, com o app novo já migrado):
//   VELHO_DATABASE_URL=postgres://... DATABASE_URL=postgres://... node scripts/importar-historico.mjs
//
// Idempotente: ON CONFLICT DO NOTHING — pode rodar de novo sem duplicar.
import pg from 'pg';

const { Pool } = pg;

const urlVelho = process.env.VELHO_DATABASE_URL;
const urlNovo = process.env.DATABASE_URL;
if (!urlVelho || !urlNovo) {
  console.error('Defina VELHO_DATABASE_URL e DATABASE_URL');
  process.exit(1);
}

const velho = new Pool({ connectionString: urlVelho });
const novo = new Pool({ connectionString: urlNovo });

const main = async () => {
  const rows = (await velho.query('SELECT * FROM wa_upsell ORDER BY criado_em')).rows;
  let importadas = 0;
  for (const r of rows) {
    const ins = await novo.query(
      `INSERT INTO wa_upsell (store, order_id, order_number, customer_phone, customer_name,
         customer_cpf, status, etapa, template_msg_id, pix_charge_id, pix_codigo,
         pix_enviado_em, pix_expira_em, criado_em, atualizado_em, despedida_enviada, disparo_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,
               CASE WHEN $16::text IS NOT NULL THEN 'enviado' ELSE NULL END)
       ON CONFLICT (store, order_id) DO NOTHING RETURNING order_id`,
      [r.store, r.order_id, r.order_number, r.customer_phone, r.customer_name,
       r.customer_cpf, r.status, r.etapa, r.template_msg_id, r.pix_charge_id, r.pix_codigo,
       r.pix_enviado_em, r.pix_expira_em, r.criado_em, r.atualizado_em, r.template_msg_id],
    );
    importadas += ins.rows.length;
  }

  const pags = (await velho.query('SELECT * FROM wa_upsell_pagamentos ORDER BY id')).rows;
  let pagImportados = 0;
  for (const p of pags) {
    const ins = await novo.query(
      `INSERT INTO wa_upsell_pagamentos (store, order_id, pagarme_charge_id, pagarme_transaction_id,
         valor, sku, quantidade, pago_em, payload, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (pagarme_charge_id) DO NOTHING RETURNING id`,
      [p.store, p.order_id, p.pagarme_charge_id, p.pagarme_transaction_id,
       p.valor, p.sku, p.quantidade, p.pago_em, p.payload, p.criado_em],
    );
    pagImportados += ins.rows.length;
  }

  console.log(`wa_upsell: ${importadas}/${rows.length} novas | pagamentos: ${pagImportados}/${pags.length} novos`);
  // Conferência da armadilha do cutover: todo pago tem pagamento no destino?
  const orfaos = await novo.query(
    `SELECT w.store, w.order_id FROM wa_upsell w
     WHERE w.etapa='pago' AND NOT EXISTS
       (SELECT 1 FROM wa_upsell_pagamentos p WHERE p.store=w.store AND p.order_id=w.order_id)`,
  );
  if (orfaos.rows.length) {
    console.error('⚠️ PAGOS SEM PAGAMENTO no destino (conferir antes do cutover):', orfaos.rows);
    process.exit(2);
  }
  console.log('✅ nenhum pago órfão — seguro pro cutover');
};

main()
  .catch((e) => {
    console.error('importação falhou:', e);
    process.exit(1);
  })
  .finally(async () => {
    await velho.end();
    await novo.end();
  });
