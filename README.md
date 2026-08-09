# agente_upsell — Gestão do Upsell via WhatsApp (Hidrabene)

Sistema completo do funil de upsell pós-compra: dispara a oferta quando um pedido é
pago (Yampi), conversa com o cliente por um agente de IA no Chatwoot, cobra via PIX
(Pagar.me), atualiza o pedido na Yampi e dá ao operador um painel com funil,
conversão, disparo controlado e aprovação de correções.

Substitui e expande o funil básico do `agente_ecom` (lógica validada em produção,
portada 1:1 — incluindo todos os gotchas documentados na spec).

## Stack

- **Backend**: Node 22 + TypeScript + Fastify (`server/`)
- **Painel**: React + Vite (`client/`, servido pelo Fastify em produção)
- **Banco**: Postgres 16 · **Fila/agendamento**: Redis 7
- **IA**: OpenAI (`gpt-5.6-luna`) · **Testes**: vitest

## Rodar local

```bash
docker compose up -d          # postgres + redis de dev
cp .env.example server/.env   # preencher (valores com o Jorge)
npm install
npm run dev                   # server :3000 + painel :5173
```

Mexer só na UI, sem banco nem Docker (painel com API falsa em :5199):

```bash
cd client && npm run dev:mock
```

Testes e typecheck:

```bash
cd server && npm test && npx tsc --noEmit
cd client && npx tsc --noEmit && npm run build
```

## Deploy

Mesmo padrão do LucroFrete: push na `main` → GitHub Actions roda testes → SSH no
servidor → `bash /opt/agente_upsell/deploy.sh` (git reset --hard origin/main →
compose up -d --build → healthcheck). Ver [docs/SETUP.md](docs/SETUP.md) para o
passo a passo completo de provisionamento (primeira vez).

## Mapa do código

| Caminho | O quê |
|---|---|
| `server/src/domain/funil.ts` | Máquina de estados do funil (disparo, aceite, PIX, pagamento, sweeper) |
| `server/src/domain/estados.ts` | Regras puras (família paga, resposta do flow, elegibilidade de disparo) |
| `server/src/domain/copies.ts` | Copies validadas em produção (default da oferta; editável no painel) |
| `server/src/domain/correcoes.ts` | Correções com aprovação humana (PUT espelhado + read-back) |
| `server/src/domain/agente/` | Agente IA (contexto, tools, guardrails, handoff) |
| `server/src/routes/webhooks.ts` | Webhooks Yampi / Pagar.me / Chatwoot / Meta |
| `server/src/routes/status.ts` | API de status do faturamento (contrato congelado) |
| `server/src/routes/admin.ts` | APIs do painel (sessão + Bearer) |
| `server/src/sweeper.ts` | Jobs: expiração de PIX, auto-close 4h, fila de disparo |
| `client/src/pages/` | Painel: Dashboard, Fila, Disparo, Oferta, Aprovações, Conversas, Relatórios, Config |

## API de status (faturamento — contrato congelado)

`GET /wa-upsell/status/{order_id_yampi}` com `Authorization: Bearer <STATUS_TOKEN>`.

- `status: "open"` → não faturar ainda; `"closed"` → faturar.
- `pagamento != null` → adicionar o SKU ao pedido.
- Pedido inexistente → `200` com `closed/fora_do_fluxo` (nunca 404).
- Sandbox: `?store=sandbox` com os casos `900000001..4`.

## Segurança

- Painel: senha bcrypt, sessão server-side httpOnly, rate limit no login, CSRF.
- APIs internas: Bearer `BACKEND_TOKEN`; status API com token separado só-leitura.
- Webhooks: token sha256 derivado na URL; Meta valida `X-Hub-Signature-256` quando
  `META_APP_SECRET` está configurado.
- Segredos só em env (`/opt/agente_upsell/.env`, fora do git). O agente IA nunca
  ecoa CPF completo nem dados de pagamento.
- Toda ação administrativa e toda aplicação na Yampi ficam na tabela `auditoria`.
