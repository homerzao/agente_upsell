-- Fundação multi-empresa (Jorge, 10/08: "esse sistema vai ser vendido, tem que
-- ser multi empresa, multi agente"). TUDO que é operacional já é escopado por
-- `store` (wa_upsell, conversas, wa_events, pedidos_status…) — o que faltava era
-- a ENTIDADE empresa e o escopo nas configs que eram singleton.
--
-- Nesta fase NADA muda de comportamento: hidrabene é semeada como empresa 1 e
-- as queries existentes continuam funcionando (colunas novas têm default).
-- A fase 2 (onboarding de empresa nova) está descrita em docs/multi-tenant.md.

CREATE TABLE IF NOT EXISTS empresas (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,          -- = valor usado na coluna `store` das outras tabelas
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  -- Credenciais/integrações POR EMPRESA. Para a hidrabene ficam vazias e o
  -- runtime cai nas envs (comportamento atual). Empresa nova = preencher aqui.
  -- Chaves previstas: meta (phone_id, waba_id, token, app_secret, verify_token,
  -- flow_id, flow_private_key), techsac (url, account_id, api_token, inbox_id),
  -- yampi (alias, token, secret), pagarme (secret_key), openai (api_key).
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO empresas (slug, nome) VALUES ('hidrabene', 'Hidrabene')
ON CONFLICT (slug) DO NOTHING;

-- Configs que eram singleton passam a ser por empresa (default preserva tudo)
ALTER TABLE disparos_config ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'hidrabene';
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'hidrabene';
CREATE INDEX IF NOT EXISTS idx_ofertas_store ON ofertas (store);

-- Blocos de prompt editáveis também são por empresa (cada marca tem sua voz)
ALTER TABLE prompt_blocos ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'hidrabene';
