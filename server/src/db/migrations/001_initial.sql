-- agente_upsell — schema inicial.
-- Porta wa_upsell / wa_upsell_pagamentos / wa_events do agente_ecom e adiciona
-- as tabelas novas da spec (ofertas, disparos_config, conversas, mensagens_ia,
-- correcoes, auditoria). Banco em UTC; exibição em America/Sao_Paulo é do painel.

-- ===== máquina de estados do funil =====
-- status: open = faturamento AGUARDA | closed = livre pra faturar.
-- etapa: aguardando_confirmacao > confirmado | corrigir_sac | recusado |
--        pix_enviado > pago | expirado | sem_resposta | erro_disparo | fora_do_fluxo
CREATE TABLE wa_upsell (
  id BIGSERIAL UNIQUE,
  store TEXT NOT NULL DEFAULT 'hidrabene',
  order_id BIGINT NOT NULL,
  order_number TEXT,
  customer_phone TEXT,
  customer_name TEXT,
  customer_cpf TEXT,          -- Pagar.me exige document no PIX (guardar desde o webhook)
  customer_email TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  etapa TEXT NOT NULL DEFAULT 'aguardando_confirmacao',
  oferta_id BIGINT,
  disparo_status TEXT,        -- fila | enviado | erro (controle do rate limit; não entra no contrato)
  template_msg_id TEXT,
  pix_charge_id TEXT,
  pix_codigo TEXT,
  pix_enviado_em TIMESTAMPTZ,
  pix_expira_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (store, order_id)
);
CREATE INDEX idx_waup_status ON wa_upsell (store, status, etapa);
CREATE INDEX idx_waup_charge ON wa_upsell (pix_charge_id);
CREATE INDEX idx_waup_criado ON wa_upsell (store, criado_em DESC);
CREATE INDEX idx_waup_fone ON wa_upsell (customer_phone);

-- Pagar.me manda charge.paid E order.paid pro MESMO pagamento (ms de diferença):
-- o UNIQUE em pagarme_charge_id + INSERT ON CONFLICT DO NOTHING RETURNING é a
-- trava atômica de dedup. NÃO remover.
CREATE TABLE wa_upsell_pagamentos (
  id BIGSERIAL PRIMARY KEY,
  store TEXT,
  order_id BIGINT,
  pagarme_charge_id TEXT,
  pagarme_transaction_id TEXT,
  valor NUMERIC(12,2),
  sku TEXT,
  quantidade INT,
  pago_em TIMESTAMPTZ,
  payload JSONB,
  criado_em TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_waup_pag_order ON wa_upsell_pagamentos (store, order_id);
CREATE UNIQUE INDEX uq_waup_pag_charge ON wa_upsell_pagamentos (pagarme_charge_id);

-- Log bruto de eventos/erros de WhatsApp e integrações (auditoria e diagnóstico)
CREATE TABLE wa_events (
  id BIGSERIAL PRIMARY KEY,
  store TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_wa_events_ts ON wa_events (created_at DESC);

-- Último status conhecido de cada pedido Yampi: o disparo acontece SÓ na
-- TRANSIÇÃO para a família paga (nunca re-dispara).
CREATE TABLE pedidos_status (
  store TEXT NOT NULL DEFAULT 'hidrabene',
  order_id BIGINT NOT NULL,
  status TEXT,
  payload JSONB,              -- último snapshot do pedido (contexto pro agente sem bater na Yampi)
  atualizado_em TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (store, order_id)
);

-- ===== oferta (gestão versionada no painel) =====
CREATE TABLE ofertas (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  sku_yampi TEXT NOT NULL,
  preco NUMERIC(12,2) NOT NULL,
  preco_de NUMERIC(12,2),
  ativo BOOLEAN NOT NULL DEFAULT false,
  copies JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ofertas_historico (
  id BIGSERIAL PRIMARY KEY,
  oferta_id BIGINT REFERENCES ofertas(id),
  snapshot JSONB NOT NULL,
  usuario TEXT,
  criado_em TIMESTAMPTZ DEFAULT now()
);

-- ===== disparo controlado (linha única) =====
CREATE TABLE disparos_config (
  id INT PRIMARY KEY CHECK (id = 1),
  modo TEXT NOT NULL DEFAULT 'test',          -- test = tudo pro fone do Jorge | live
  cpf_filtro TEXT[] NOT NULL DEFAULT '{}',    -- vazio = aberto pra todos
  rate_por_hora INT NOT NULL DEFAULT 0,       -- 0 = sem limite
  pausado BOOLEAN NOT NULL DEFAULT false,     -- kill switch global
  amostra_restante INT,                       -- NULL = sem amostragem; N = próximos N pedidos
  atualizado_em TIMESTAMPTZ DEFAULT now()
);

-- ===== agente IA =====
CREATE TABLE conversas (
  id BIGSERIAL PRIMARY KEY,
  wa_upsell_id BIGINT REFERENCES wa_upsell(id),
  chatwoot_conversation_id BIGINT UNIQUE,
  chatwoot_contact_id BIGINT,
  status TEXT NOT NULL DEFAULT 'bot',         -- bot | humano
  handoff_motivo TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_conversas_waup ON conversas (wa_upsell_id);

CREATE TABLE mensagens_ia (
  id BIGSERIAL PRIMARY KEY,
  conversa_id BIGINT REFERENCES conversas(id),
  direcao TEXT NOT NULL,                      -- in | out
  texto TEXT,
  prompt_hash TEXT,                           -- sha256 do contexto usado (auditoria)
  contexto JSONB,                             -- prompt/contexto completo da chamada
  tokens INT,
  custo NUMERIC(12,6),
  criado_em TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_msgs_conversa ON mensagens_ia (conversa_id, criado_em);

-- ===== correções com aprovação humana =====
-- NUNCA aplicar update na Yampi sem aprovação (status aprovada -> aplicada).
CREATE TABLE correcoes (
  id BIGSERIAL PRIMARY KEY,
  wa_upsell_id BIGINT REFERENCES wa_upsell(id),
  campos_antes JSONB NOT NULL,
  campos_depois JSONB NOT NULL,
  put_yampi JSONB NOT NULL,                   -- {recurso, id, body} exato que será enviado
  status TEXT NOT NULL DEFAULT 'aguardando_aprovacao',
  -- aguardando_aprovacao | aprovada | rejeitada | aplicada | erro_aplicacao
  aprovador TEXT,
  motivo TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  decidido_em TIMESTAMPTZ,
  aplicado_em TIMESTAMPTZ
);
CREATE INDEX idx_correcoes_status ON correcoes (status, criado_em);

-- ===== auditoria de ações administrativas =====
CREATE TABLE auditoria (
  id BIGSERIAL PRIMARY KEY,
  usuario TEXT,
  acao TEXT NOT NULL,
  alvo TEXT,
  payload JSONB,
  criado_em TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_auditoria_ts ON auditoria (criado_em DESC);
