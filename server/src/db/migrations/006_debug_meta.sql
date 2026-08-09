-- Toggle do log de diagnóstico do webhook da Meta (aba Logs do painel).
-- Nasce LIGADO: estamos investigando a distribuição de inbound entre os apps.
ALTER TABLE disparos_config ADD COLUMN IF NOT EXISTS debug_meta BOOLEAN NOT NULL DEFAULT false;
UPDATE disparos_config SET debug_meta = true WHERE id = 1;
