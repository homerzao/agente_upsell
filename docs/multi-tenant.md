# Multi-empresa (Ticket Dourado como produto)

Visão do Jorge (10/08/2026): o sistema de upsell vai ser **vendido/plugado em outras
empresas** — multi-empresa, multi-agente, operando mais de uma marca.

## O que JÁ existe (fase 1, no ar)

- Escopo por `store` em todas as tabelas operacionais (`wa_upsell`, `conversas`,
  `wa_events`, `pedidos_status`, `mensagens_ia`, `correcoes`…) — desde o dia 1.
- Tabela **`empresas`** (migration 015): slug (= `store`), nome, ativo e `config`
  JSONB para credenciais por empresa. Hidrabene semeada como empresa 1 com config
  vazia → runtime cai nas envs (zero mudança de comportamento).
- `disparos_config`, `ofertas` e `prompt_blocos` ganharam coluna `store`
  (default `hidrabene`): cada empresa terá seu kill switch, suas ofertas/faixas
  e sua voz de IA.
- Multi-oferta por faixa de ticket (migration 014) já é por store por herança.

## O que falta pra plugar a empresa nº 2 (fase 2 — NÃO é uma noite)

1. **Resolver credenciais por request**: hoje `ctx.cfg` vem do env na subida.
   Precisa de um `resolverEmpresa(store)` que monte o ctx (Meta, TechSAC, Yampi,
   Pagar.me, OpenAI) a partir de `empresas.config`, com cache e fallback pro env
   quando vazio (hidrabene).
2. **Webhooks com roteamento**: `/webhook/meta` identifica a empresa pelo
   `phone_number_id` do payload; `/webhook/yampi/<slug>` já nasce roteado.
   Um app Meta por empresa (ou multi-number no mesmo WABA — decidir por cliente).
3. **Flow por empresa**: o flow v8 é dinâmico via data_exchange, então UM flow
   atende N empresas SE estiverem no mesmo WABA; WABA separado = publicar o mesmo
   JSON por WABA e gravar `flow_id` na config da empresa.
4. **Painel**: seletor de empresa no topo (o front já recebe `store` em tudo);
   usuários com permissão por empresa (tabela `usuarios_empresas`).
5. **Faturamento/contrato**: o endpoint `/wa-upsell/status/:orderId` ganha o slug
   na rota ou o token identifica a empresa (token por empresa na `config`).
6. **Isolamento de custo**: `mensagens_ia.custo` já existe por conversa → relatório
   de consumo OpenAI por empresa sai de graça.

## Decisões tomadas nesta fase

- `slug` da empresa = valor da coluna `store` (não inventar segundo identificador).
- Credencial em `empresas.config` (JSONB) e não em env: env não escala pra N
  empresas. Migração gradual: config vazia = usa env.
- O agente de IA é o MESMO código com blocos de prompt por store — "multi-agente"
  = cada empresa edita sua persona sem deploy (painel/MCP já fazem isso hoje).
