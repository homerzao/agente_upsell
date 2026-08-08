-- Atualizações pós-validação em produção (07-08/08/2026):
-- despedida no fechamento do flow enviada UMA vez por row.
ALTER TABLE wa_upsell ADD COLUMN despedida_enviada BOOLEAN NOT NULL DEFAULT false;
