-- Multi-oferta por faixa de ticket (Jorge, 10/08):
-- a oferta é escolhida pelo VALOR DE PRODUTO do pedido (subtotal - desconto, SEM frete).
-- Faixa [ticket_min, ticket_max): NULL = sem limite daquele lado. Empate de faixa
-- resolve por prioridade (maior vence) — assim uma oferta "geral" (faixa toda NULL)
-- convive com faixas específicas sem precisar reconfigurar a geral.
-- sku_gatilho: reservado pra fase 2 (oferta condicionada a SKU no carrinho).
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS ticket_min NUMERIC(12,2);
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS ticket_max NUMERIC(12,2);
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS prioridade INT NOT NULL DEFAULT 0;
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS sku_gatilho TEXT;

-- Ticket do pedido gravado na row do funil: análise de conversão POR FAIXA sem
-- precisar voltar na Yampi.
ALTER TABLE wa_upsell ADD COLUMN IF NOT EXISTS valor_produtos NUMERIC(12,2);
