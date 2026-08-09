-- Marcos de entrega/leitura do template (statuses da Meta) para medir o funil
-- de verdade: quanto tempo até ler, quantos leem, e o que os que leram fizeram.
ALTER TABLE wa_upsell ADD COLUMN IF NOT EXISTS entregue_em TIMESTAMPTZ;
ALTER TABLE wa_upsell ADD COLUMN IF NOT EXISTS lido_em TIMESTAMPTZ;
ALTER TABLE wa_upsell ADD COLUMN IF NOT EXISTS abriu_flow_em TIMESTAMPTZ;
ALTER TABLE wa_upsell ADD COLUMN IF NOT EXISTS aceitou_em TIMESTAMPTZ;
ALTER TABLE wa_upsell ADD COLUMN IF NOT EXISTS disparado_em TIMESTAMPTZ;
