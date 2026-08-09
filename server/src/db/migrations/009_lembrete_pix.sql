-- Marca que o lembrete de PIX já saiu (um por cobrança, nunca repete).
ALTER TABLE wa_upsell ADD COLUMN IF NOT EXISTS lembrete_pix_em TIMESTAMPTZ;
