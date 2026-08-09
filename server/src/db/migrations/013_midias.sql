-- Guarda a mídia que o cliente manda (imagem/áudio) para o HUMANO ver no painel
-- — a descrição da IA serve pro contexto dela, não pra quem vai atender.
-- No banco (não em disco) pra sobreviver a deploy/restart do container.
CREATE TABLE IF NOT EXISTS midias (
  id BIGSERIAL PRIMARY KEY,
  conversa_id BIGINT REFERENCES conversas(id),
  tipo TEXT NOT NULL,           -- image | audio
  mime TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  criado_em TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_midias_conversa ON midias (conversa_id, id DESC);
