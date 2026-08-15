-- IA analista de aprovações (pedido do Jorge, 15/08): revisa correções pendentes
-- e aprova sozinha o caso claro; o resto fica na fila humana COM parecer.
-- Ela NUNCA rejeita e NUNCA envia mensagem ao cliente.
ALTER TABLE correcoes ADD COLUMN IF NOT EXISTS analista_decisao TEXT;
ALTER TABLE correcoes ADD COLUMN IF NOT EXISTS analista_parecer TEXT;
ALTER TABLE correcoes ADD COLUMN IF NOT EXISTS analista_em TIMESTAMPTZ;
-- Kill switch no painel/API (PUT /api/disparo {analista_ativo:false})
ALTER TABLE disparos_config ADD COLUMN IF NOT EXISTS analista_ativo BOOLEAN NOT NULL DEFAULT TRUE;
