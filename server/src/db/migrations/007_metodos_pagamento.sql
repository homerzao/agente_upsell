-- Filtro por método de pagamento (pedido do Jorge, 09/08): só PIX entra no
-- funil; cartão/boleto ficam closed/fora_do_fluxo (o faturamento segue normal).
-- Vazio = aceita todos. Alias vem da Yampi (payments[0].alias): pix, mastercard,
-- visa, elo, amex, billet…
ALTER TABLE disparos_config ADD COLUMN IF NOT EXISTS metodos_permitidos TEXT[] NOT NULL DEFAULT '{pix}';
