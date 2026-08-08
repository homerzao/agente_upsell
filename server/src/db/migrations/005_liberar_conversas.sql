-- Liberação da conversa pro fluxo normal do SAC (destravar no TechSAC):
-- liberada_em marca quando a conversa saiu do domínio do funil/agente.
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS liberada_em TIMESTAMPTZ;
