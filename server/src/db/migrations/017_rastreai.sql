-- Claim atômico do envio ao RastreiAI.
-- A rota /cashback/order-items NÃO é idempotente: cada POST adiciona o item de novo.
-- Marcar ANTES de postar (UPDATE ... WHERE rastreai_enviado_em IS NULL RETURNING id) é o
-- que garante um item por pagamento, mesmo com webhook repetido ou backfill rodando junto.
ALTER TABLE wa_upsell_pagamentos ADD COLUMN IF NOT EXISTS rastreai_enviado_em TIMESTAMPTZ;
