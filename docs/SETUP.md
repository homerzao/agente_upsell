# SETUP — provisionamento e go-live (passo a passo pro Jorge)

Checklist do que só você consegue fazer (credenciais e acessos). O código já está
pronto pra tudo isso — nenhum passo exige mudança de código.

## 1. Servidor (2.25.145.73, uma vez)

```bash
ssh root@2.25.145.73
git clone https://github.com/homerzao/agente_upsell /opt/agente_upsell
cd /opt/agente_upsell
cp .env.example .env
nano .env        # preencher TODOS os valores (ver §3)
bash deploy.sh   # primeiro build + up
```

Pré-requisito (igual LucroFrete): a rede overlay `easypanel` precisa existir
(`docker network ls | grep easypanel`). O Traefik do EasyPanel roteia o domínio
via labels do compose.

## 2. DNS + domínio

- Escolher o domínio do sistema (ex.: `upsell.hidrabene.com.br`), apontar A record
  pro servidor e colocar em `APP_DOMAIN` no `.env`.
- O Traefik emite o certificado sozinho (letsencrypt) no primeiro acesso.

## 3. `.env` (valores)

| Env | De onde vem |
|---|---|
| `POSTGRES_PASSWORD` | inventar (forte) |
| `BACKEND_TOKEN` | inventar (forte, ≥32 chars) |
| `STATUS_TOKEN` | inventar — é o token que o dev do faturamento já usa hoje; **manter o mesmo valor do agente_ecom** pra troca ser transparente |
| `SESSION_SECRET` | inventar |
| `ADMIN_USER` / `ADMIN_PASS_HASH` | `node -e "console.log(require('bcryptjs').hashSync('SENHA', 12))"` |
| `METAWA_*` | Meta Business (mesmo número/WABA do funil atual) |
| `META_APP_SECRET` | **OBRIGATÓRIO no cutover** — a Meta chama DIRETO (decisão tomada, sem n8n); sem ele o webhook fica sem validação de assinatura (o boot avisa) |
| `FLOW_PRIVATE_KEY` | chave privada RSA do NÚMERO (data channel do flow v6+). É a MESMA do agente_ecom (state `flow_private_key`) — **NUNCA gerar par novo** (quebraria o endpoint em produção). PEM em uma linha com `\n` escapado |
| `WA_UPSELL_JANELA_MIN` | 25 (janela pré-aceite, alinhada ao ERP ~28min) — default já correto |
| `CHATWOOT_*` | TechSAC: criar um usuário API dedicado pro bot + pegar o ID da inbox do WhatsApp. `CHATWOOT_AGENT_ID` = id do usuário-agente IA (atribuição); `CHATWOOT_TEAM_ID` = id do time humano (handoff) |
| `YAMPI_*` | painel Yampi |
| `PAGARME_SECRET_KEY` | Pagar.me v5 |
| `OPENAI_API_KEY` | sua chave; `OPENAI_MODEL=gpt-5.6-luna` |

## 4. GitHub Actions (deploy automático)

No repo `homerzao/agente_upsell` → Settings → Secrets and variables → Actions:

- `DEPLOY_HOST` = `2.25.145.73`
- `DEPLOY_SSH_KEY_B64` = chave privada em base64 numa linha
  (`base64 -w0 ~/.ssh/chave_deploy`) — pode REUSAR a mesma chave do LucroFrete,
  já que o servidor é o mesmo.

## 5. Webhooks (depois do app no ar)

Abrir o painel → **Config**: as URLs prontas (com token) estão lá pra copiar.

1. **Yampi**: botão "Criar webhook na Yampi" no painel (cria via API e já ativa —
   webhook criado por API nasce `active:false`, o sistema faz o PUT de ativação).
2. **Pagar.me**: cadastrar a URL `…/webhook/pagarme?t=…` no painel da Pagar.me
   (eventos de pedido/cobrança paga).
3. **Chatwoot**: Settings → Integrations → Webhooks → URL `…/webhook/chatwoot?t=…`,
   evento `message_created`.
4. **Meta — DIRETO (sem n8n, decisão tomada)**: apontar o callback do app Meta pra
   `…/webhook/meta`, verificar com o `METAWA_VERIFY_TOKEN` e configurar
   `META_APP_SECRET`. O sistema filtra o firehose sozinho: só processa/persiste
   nfm_reply do funil, status dos NOSSOS templates e texto de lead em contexto
   ativo (open ou fechado < 24h); mensagens de lead são injetadas na conversa do
   Chatwoot via API (o Chatwoot não recebe mais sozinho). Dedup por wamid (7 dias)
   cobre as reentregas da Meta; retenção de wa_events: 30 dias (pagamentos ficam).

## 6. Chatwoot (agente IA)

1. Criar usuário dedicado (ex.: "Agente Hidrabene") com token de API → `CHATWOOT_API_TOKEN`.
2. `CHATWOOT_AGENT_ID` = id desse usuário (a conversa do funil é atribuída a ele,
   label `upsell-ticket-dourado`).
3. Handoff: label `precisa-humano` + atribuição ao `CHATWOOT_TEAM_ID` (criar o time
   se não existir).

## 7. Template e Flow (Meta) — v6 → v7 no cutover

Produção usa o template `confirma_pedido_up` repontado pro **flow v6
`3548925675262517`** (data_exchange: o "Confirmar Pedido" chama o data channel).
O `endpoint_uri` de um flow publicado é IMUTÁVEL e o do v6 aponta pro agente_ecom
— por isso o cutover cria um **v7 idêntico ao v6** com `endpoint_uri` =
`https://$APP_DOMAIN/flow/upsell`:

1. Copiar a `flow_private_key` do agente_ecom pro `.env` (`FLOW_PRIVATE_KEY`).
2. Validar o endpoint simulando a Meta (os testes de integração do repo fazem
   isso; em produção, o publish do v7 valida o ping ao vivo).
3. Criar o v7 com o MESMO JSON do v6 (script `montar-flow-v5.mjs` +
   `flow-ticket-v6.json` no agente_ecom; ou baixar a estrutura da Meta com
   `GET /{flow_id}?fields=preview.invalidate(false)`), publicar — o endpoint
   PRECISA estar no ar antes.
4. Repontar o template pro v7 (só no passo certo do cutover, ver §9).

Header do template usa media id que expira ~30 dias — preferir URL própria na
copy `header_url` da oferta (painel → Oferta).

## 8. Ensaio em modo test (antes de qualquer live)

O sistema NASCE seguro: `modo=test` (tudo pro seu fone), filtro de CPF = só o seu.

1. Painel → Config → **test-send** (confere credencial da Meta).
2. Fazer um pedido real com seu CPF → conferir: template chega, flow responde,
   aceite gera PIX de R$ 49,91, pagamento fecha `pago`, anotação aparece na Yampi,
   confirmação 🎉 chega.
3. Conferir a API de status com o token do faturamento:
   `curl -H "Authorization: Bearer $STATUS_TOKEN" https://$APP_DOMAIN/wa-upsell/status/900000001?store=sandbox`
4. Testar o agente: responder qualquer coisa na conversa → o bot responde;
   pedir correção de endereço → aparece em Aprovações com diff → aprovar →
   confere na Yampi.

## 9. CUTOVER — ordem obrigatória (o velho fica no ar até o fim)

A armadilha: um pedido `pago` no banco velho consultado no banco novo responderia
`fora_do_fluxo` SEM pagamento → o faturamento faturaria SEM adicionar o SKU pago.
Por isso a ordem abaixo importa:

1. Deploy deste sistema com defaults seguros (`pausado=true`, modo test, filtro no
   seu CPF) — sobe sem receber tráfego nenhum.
2. **Chave do flow**: copiar a `flow_private_key` pro `.env` novo e validar
   `/flow/upsell` (ping + sandbox `900000001` dentro / `900000002` fora da janela).
3. **Flow v7**: criar idêntico ao v6 com `endpoint_uri` novo e publicar
   (o publish valida o ping). NÃO repontar o template ainda.
4. **Congelar o velho**: pausar disparos no agente_ecom e esperar as rows `open`
   esvaziarem (máx 4h se houver `corrigir_sac`; senão ~25min).
5. **Importar histórico**:
   `VELHO_DATABASE_URL=... DATABASE_URL=... node scripts/importar-historico.mjs`
   (idempotente; aborta se sobrar `pago` sem pagamento).
6. **Trocar as pontas** (qualquer ordem depois do 5):
   - Webhook Yampi → URL nova (botão no painel Config);
   - Webhook Pagar.me → URL nova;
   - Callback do app Meta → URL nova + `META_APP_SECRET` + verify token;
   - Repontar o template pro **flow v7**;
   - Dev do faturamento troca a base URL (mesmo `STATUS_TOKEN` → troca invisível).
   Enquanto o template apontar pro v6, o data_exchange continua caindo no
   agente_ecom — que segue no ar até aqui. Sem downtime se a ordem for respeitada.
7. **Ensaio E2E** com pedido/CPF seu (modo test) antes de abrir o filtro.
8. Rollout gradual: amostra N=5 → acompanhar → abrir filtro de CPF → `live`.
   Depois: `WA_UPSELL_ENABLED=0` no agente_ecom (a ingestão do banco central
   continua intacta lá).

## Decisão em aberto

- **Agent Bot vs usuário-agente no Chatwoot**: implementado com usuário-agente
  dedicado + atribuição via API (mais simples de operar no TechSAC). Se preferir
  Agent Bot nativo, é trocar a atribuição — falar com o dev.
