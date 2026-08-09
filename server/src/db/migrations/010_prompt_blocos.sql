-- Blocos do system prompt editáveis SEM DEPLOY (pedido do Jorge, 09/08: cada
-- ajuste de regra da IA exigia deploy, e deploy no meio do funil é risco).
-- Vazio/ausente = usa o default do código (blocosPadrao em contexto.ts).
CREATE TABLE IF NOT EXISTS prompt_blocos (
  chave TEXT PRIMARY KEY,
  conteudo TEXT NOT NULL,
  atualizado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_por TEXT
);
