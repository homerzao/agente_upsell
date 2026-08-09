-- conversation_id INTERNO do Chatwoot: é ele (não o display_id) que a rota de
-- destravar do TechSAC aceita. Vem no response do send_template v2 — a API v1
-- não expõe em lugar nenhum, por isso guardamos no disparo.
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS chatwoot_conv_interno BIGINT;

-- Arquivar conversa no painel (some da lista padrão; dá pra ler depois)
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS arquivada_em TIMESTAMPTZ;

-- Conversa do Jorge (teste): id interno informado pelo dev do TechSAC
UPDATE conversas SET chatwoot_conv_interno = 1959587
WHERE chatwoot_conversation_id = 6799 AND chatwoot_conv_interno IS NULL;
