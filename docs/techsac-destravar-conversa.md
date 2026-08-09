# TechSAC — por que não conseguimos destravar a conversa (para o dev)

Contexto: o sistema do upsell (agente IA no número +55 47 9138-6927, account 12) precisa
destravar a conversa em dois momentos — no handoff pro time humano e quando o funil
encerra (pra resposta do cliente voltar a cair na sessão normal do SAC). O código já
chama a rota que você passou, com retry automático a cada 60s. O problema não é de
lógica: é que a rota responde 404 pra gente. Evidências e hipóteses abaixo.

## O que está acontecendo (evidência coletada 08/08, ~20h)

A conversa do teste é a **6799** da account 12 (contato +55 91 99214-8793, pedido
169610420). Ela foi criada pelo nosso sistema via API padrão do Chatwoot
(`POST /api/v1/accounts/12/conversations`) e nasceu **travada**:

```
GET /api/v1/accounts/12/conversations/6799
→ 200 { "id": 6799, "locked": true, "uuid": "bfe71dfe-d371-...", ... }
```

A rota de destravar que você passou:

```
PATCH /api/v1/accounts/12/conversations/6799   body: {"locked": false}
→ 404 {"error":"Resource could not be found"}
```

O mesmo id 6799 funciona normal em `GET .../conversations/6799` e em
`POST .../conversations/6799/messages` (nossas notas internas entram por aí). Também
tentamos, todas 404: `POST .../conversations/6799/toggle_lock`,
`PATCH /api/v2/accounts/12/conversations/6799` e
`PATCH /api/v2/whatsapp/conversations/6799`.

Token usado: o mesmo `api-access-token` das outras rotas (que funcionam) — então não é
autenticação. E estamos mandando o header com HÍFEN (`api-access-token`), que passa pelo
nginx; com underscore o nginx derruba (batemos nisso mais cedo em outra rota).

## Hipótese principal: os 2 IDs

Você mesmo comentou que a conversa tem 2 ids (o `conversation_id` interno e o
`display_id`). O **6799 é o display_id** — é o id que a API padrão do Chatwoot usa em
todos os paths `api/v1`. Nossa aposta: a rota custom do PATCH faz lookup pelo
`conversations.id` interno (PK global da instância), que pra account 12 é um número
diferente de 6799 — daí o "Resource could not be found".

O detalhe: como o nosso disparo hoje vai direto pela Meta (não pela tua rota
`send_template` v2), a gente **nunca recebe o conversation_id interno** — só temos o
display_id que a API padrão devolve. E o payload do `GET /conversations/:display_id`
não expõe o id interno (só id=display, uuid, etc.).

Segunda hipótese (mais simples): a rota do PATCH ainda não está no ar em produção.

## O que resolveria (qualquer UMA destas, em ordem de preferência)

1. **PATCH aceitar o display_id** — no handler, resolver por
   `account.conversations.find_by(display_id: params[:id])` (escopado na account).
   É a opção que destrava tudo hoje, inclusive conversas antigas, sem mudança do
   nosso lado: o retry de 60s do nosso sweeper faz o resto sozinho.
2. **Expor o id interno** pra gente — por exemplo no payload do
   `GET /conversations/:display_id` (um campo `internal_id`), ou aceitar o `uuid`
   no PATCH. Aí guardamos e usamos.
3. **A gente migrar o disparo pra tua rota `send_template` v2** e guardar o
   `conversation_id` do response — já está no roadmap (junto com o `display_id` que
   você disse que ia expor no response), mas só cobre conversas novas; as criadas
   via API padrão continuariam presas sem a opção 1 ou 2.

## Pergunta bônus

Conversa criada via API padrão (como a 6799) está nascendo `locked: true` — é
intencional no fluxo de vocês? Se for, beleza (contanto que o destravar funcione);
se não for, vale conferir o default, porque cliente respondendo numa conversa travada
sem dono fica no limbo.

## Do nosso lado, já está pronto

- Handoff pro humano → chama o PATCH na hora.
- Funil encerrado + 60 min sem interação → sweeper chama o PATCH (retry a cada 60s
  enquanto falhar, com log `destravar_conversa_falhou` em `wa_events`).
- Assim que a rota responder 200, tudo se resolve sozinho — sem deploy nosso.

Qualquer coisa: Jorge.
