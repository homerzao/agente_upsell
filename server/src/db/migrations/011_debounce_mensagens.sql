-- Debounce: mensagem do cliente entra como NÃO processada e o sweeper junta
-- tudo que chegou em sequência antes de responder uma vez só (pedido do Jorge,
-- 09/08 — a IA respondia cada fragmento e virava pingue-pongue).
-- Default TRUE para o histórico não ser reprocessado.
ALTER TABLE mensagens_ia ADD COLUMN IF NOT EXISTS processada BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_msgs_pendentes ON mensagens_ia (conversa_id) WHERE direcao = 'in' AND processada = false;
