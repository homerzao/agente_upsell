# Integração TechSAC (Chatwoot) — disparo via rota própria + lock de conversa

Informações passadas pelo dev do TechSAC (08/08/2026). O TechSAC expõe uma rota própria
que dispara o template E cria a conversa no Chatwoot já travada — isso muda a forma
preferida de disparo do funil (hoje o código manda direto na Graph API da Meta e cria
contato/conversa por fora).

## Rota de disparo (v2, do TechSAC)

```
POST https://chat.techsac.com.br/api/v2/whatsapp/send_template
Header: api-access-token: <CHATWOOT_API_TOKEN>
```

Body (exemplo real do dev, adaptar bindings):

```json
{
  "to_number": "5591992148793",
  "contact_name": "Jorge",
  "template": {
    "name": "confirma_pedido_up_v4",
    "language": { "policy": "deterministic", "code": "pt_BR" }
  },
  "components": [
    { "type": "header", "parameters": [{ "type": "image", "image": { "id": "4547821698825386" } }] },
    { "type": "body", "parameters": [
      { "type": "text", "text": "Jorge" },
      { "type": "text", "text": "1517221321295822" }
    ] },
    { "type": "button", "sub_type": "flow", "index": "0", "parameters": [
      { "type": "action", "action": {
        "flow_token": "hidrabene:169610420",
        "flow_action_data": { "saudacao": "...", "linha_pedido": "...", "linha_nome": "...",
          "linha_email": "...", "linha_endereco": "...", "titulo_ticket": "...",
          "corpo_corrigir": "...", "saudacao_ok": "..." }
      } }
    ] }
  ],
  "lock_conversation": true
}
```

## Semântica do lock

- `lock_conversation: true` → a resposta do cliente **não abre sessão** no fluxo normal
  do chat (a conversa fica travada com a gente).
- O response do send_template traz `conversation_id` **e** `display_id` (o dev expôs o
  display_id nessa rota — build recente; validar no response real antes de confiar).
- **Destravar** (resposta do cliente volta a cair no fluxo de sessão normal do SAC):

```
PATCH https://chat.techsac.com.br/api/v1/accounts/12/conversations/:conversation_id
Header: api-access-token: <token>
Body: { "locked": false }
```

- **Nota interna** (usa o `display_id`, NÃO o conversation_id — Chatwoot tem 2 ids por
  conversa):

```
POST https://chat.techsac.com.br/api/v1/accounts/12/conversations/:display_id/messages
Body: { "content": "nota interna aqui", "private": true }
```

## O que muda no agente_upsell (proposta)

1. **Disparo preferido via TechSAC** quando `CHATWOOT_URL` configurado: substitui o
   `meta.waSendRaw` do template E o `criarConversaChatwoot` (a rota já cria a conversa).
   Guardar `conversation_id` e `display_id` na row (`wa_upsell` ou `conversas`).
   Fallback: Meta direto (comportamento atual) se a rota falhar/não configurada.
2. **Lock**: disparar com `lock_conversation: true`. Enquanto travada, as respostas do
   cliente chegam pelo webhook da Meta (direto) e o funil/agente IA processa.
3. **Unlock** no handoff: ao entrar em `corrigir_sac`/`precisa-humano`, PATCH
   `locked:false` para a conversa cair no fluxo normal do SAC humano.
4. **Notas internas** nos marcos (aceite, PIX enviado, pago, correção aplicada) via
   display_id — a equipe vê o contexto sem sair do Chatwoot.
5. Mapear inbox: número do upsell +55 47 9138-6927 = inbox **65** da account **12**.

## Cuidados

- O response do send_template é a fonte dos 2 ids; se vier sem `display_id` (build do
  dev ainda não em prod), guardar só conversation_id e buscar o display depois
  (GET conversation).
- Dedup de eco continua necessário: a injeção/entrega nativa pode duplicar eventos no
  webhook do Chatwoot (`source_id` já tratado no código).
- Token atual da integração: env `CHATWOOT_API_TOKEN` (mesmo token das rotas v1).
