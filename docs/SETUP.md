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
| `META_APP_SECRET` | opcional; se a Meta chamar DIRETO o webhook, configurar pra validar assinatura. Se mantiver o n8n forwardando, deixar vazio |
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
4. **Meta**: decisão sua (o endpoint aceita os DOIS formatos):
   - **Direto**: apontar o webhook do app Meta pra `…/webhook/meta`, verificar com
     o `METAWA_VERIFY_TOKEN`, e configurar `META_APP_SECRET` pra validar assinatura; ou
   - **Manter o n8n**: o n8n continua filtrando `nfm_reply` e passa a forwardar pra
     `…/webhook/meta` (sem assinatura — deixar `META_APP_SECRET` vazio).

## 6. Chatwoot (agente IA)

1. Criar usuário dedicado (ex.: "Agente Hidrabene") com token de API → `CHATWOOT_API_TOKEN`.
2. `CHATWOOT_AGENT_ID` = id desse usuário (a conversa do funil é atribuída a ele,
   label `upsell-ticket-dourado`).
3. Handoff: label `precisa-humano` + atribuição ao `CHATWOOT_TEAM_ID` (criar o time
   se não existir).

## 7. Template e Flow (Meta)

O sistema usa o template APROVADO atual (`confirma_pedido_up_v4`) e o flow
`3351881904991012` — nada a fazer. Se um dia editar o flow: flow publicado é
IMUTÁVEL (criar novo + repontar template = nova análise). O header do template usa
media id que expira ~30 dias — preferir colocar uma URL de imagem própria na copy
`header_url` da oferta (painel → Oferta).

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

## 9. Rodar em paralelo e cortar o agente_ecom

1. Deixar os DOIS sistemas recebendo webhooks em paralelo, este em modo test,
   até os estados baterem 1:1 (comparar fila daqui com `/wa-upsell/fila` de lá).
2. Apontar o consumidor de status do faturamento pra cá (mesmo contrato, mesmo token).
3. No agente_ecom (EasyPanel): `WA_UPSELL_ENABLED=0` (desliga o funil de lá;
   a ingestão de pedidos do banco central continua intacta).
4. Rollout gradual AQUI: painel → Disparo → amostra N=5 → acompanhar → abrir filtro
   de CPF → `live`.

## Decisões em aberto (o sistema suporta os dois lados)

- **Meta direto vs n8n** (§5.4): decidir e configurar.
- **Agent Bot vs usuário-agente no Chatwoot**: implementado com usuário-agente
  dedicado + atribuição via API (mais simples de operar no TechSAC). Se preferir
  Agent Bot nativo, é trocar a atribuição — falar com o dev.
