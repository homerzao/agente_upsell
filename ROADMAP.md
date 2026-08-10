# Roadmap — virada de 09→10/08/2026 (pedido do Jorge, ~23h)

> Contexto: disparos PAUSADOS (kill switch ligado às 22:15 de 09/08). Nada em produção
> dispara enquanto isso; os pedidos em voo terminam sozinhos. Liberdade pra subir e testar.
> Regra de separação: TUDO deste roadmap mora no agente_upsell. Nada de skill/código
> do agente_ecom entra aqui, e vice-versa.

## Legenda
`[ ]` a fazer · `[~]` em andamento · `[x]` feito e testado · `[!]` precisa de decisão do Jorge

## 1. Guard-rails imediatos (antes de qualquer coisa)
- [ ] **Proibir correção de CIDADE / UF / CEP** — muda custo de frete. Camadas:
      (a) `registrarCorrecao` rejeita os campos no código (não confia só no prompt);
      (b) tool devolve motivo pra IA explicar ao cliente e encaminhar ao humano;
      (c) bloco de prompt atualizado. Permitidos: rua, número, complemento, bairro, destinatário.
- [ ] **Auto-arquivar conversa finalizada** — sweeper arquiva conversa liberada pro SAC
      há 30+ min sem correção pendente. Lista principal fica só com o realmente aberto.
- [ ] **Aba Aprovações legível** — sai o JSON cru; entra tabela campo a campo com
      ANTES → DEPOIS e só os campos que mudaram em destaque.

## 2. Funil multi-oferta por faixa de ticket
Régua = **valor de PRODUTO do pedido (subtotal − desconto, SEM frete)**.
- [ ] Schema: `ofertas` ganha `ticket_min`, `ticket_max`, `prioridade`, `sku_gatilho`
      (gatilho por SKU no carrinho fica pronto no schema, ainda sem uso).
- [ ] Elegibilidade: na hora do disparo escolhe a oferta pela faixa; sem faixa que case → não dispara.
- [ ] Oferta nova: **PROTETOR FPS 70 CLAREADOR (SKU 2080) a R$ 19,90** para pedidos < R$ 50.
      Oferta atual (Kit Clareador 2133823 a R$ 49,91) para pedidos ≥ R$ 50.
- [ ] Copies próprias da oferta nova (o copies já é por oferta — ok).
- [ ] Painel: config das faixas visível/editável.
- [ ] Contrato do faturamento intocado: a resposta já devolve `sku` dinâmico — o ERP não muda.
- [!] Preço da oferta nova: Jorge falou **19,90**; a convenção da casa é terminar em **,91**.
      Vou de 19,90 (palavra dele) e pergunto no WhatsApp.
- [!] Disparo continua PIX-only? A régua nova não muda isso por ora.

## 3. Flow v8 — double-check anti-clique-acidental
Problema: gente clicando o botão verde sem querer → PIX gerado à toa (150 aceites → 28 pagos).
- [ ] Tela extra de CONFIRMAÇÃO após o aceite: resume o que a pessoa leva
      ("Kit X por R$ Y, entra no MESMO pedido, sem frete extra") + escolha explícita:
      **radio** "✅ Sim — gerar meu código PIX" / "❌ Não quero a oferta" + botão Confirmar.
      Só gera PIX quem marcou SIM e confirmou. Recusa no radio = recusa registrada, com despedida.
- [ ] Textos do flow ficam DINÂMICOS via data_exchange (produto/preço vêm da oferta da faixa) —
      necessário pro multi-oferta usar o MESMO flow.
- [ ] Montar em DRAFT + preview pro Jorge avaliar ANTES de publicar (publicado é imutável).
- [ ] Template novo apontando pro flow v8 (só depois do OK dele; cutover amanhã).
- [ ] Métrica nova: quantos passam do aceite-1 e desistem no double-check (mede o clique acidental).

## 4. 360º das conversas da IA
- [ ] Baixar TODAS as conversas + mensagens.
- [ ] Workflow de análise em paralelo: erros de fato, tom, oportunidades perdidas, silêncio errado,
      loops, promessas indevidas — cada achado com exemplo real.
- [ ] Ajustar blocos de prompt pelo MCP (sem deploy) e registrar o que mudou.

## 5. Visual novo (padrão tcomentai) + identidade
- [ ] Extrair o design system do github.com/homerzao/tcomentai (cores, tipografia, layout, componentes).
- [ ] Reestilizar o painel do upsell nesse padrão.
- [ ] Logo do produto (MCP de imagem — autorizado).
- [ ] Nova arte do Ticket Dourado (MCP de imagem) — candidata a header do template novo.
- [!] Nome do produto pra logo? (hoje o repo chama "agente_upsell"; painel não tem marca).

## 6. Multi-empresa / multi-agente (fundação)
Visão: o sistema vai ser vendido/plugado em outras empresas.
- [ ] Hoje TUDO já é escopado por `store` (coluna em todas as tabelas) — a fundação existe.
- [ ] Tabela `empresas` (tenant): nome, slug, credenciais Meta/TechSAC/Yampi/Pagar.me próprias,
      ativo. `disparos_config` e `ofertas` passam a ser por empresa.
- [ ] Painel: seletor de empresa no topo; usuários por empresa (fase 2).
- [ ] Documento de arquitetura do multi-tenant: o que falta pra plugar a empresa nº 2
      (honesto: onboarding completo NÃO fica pronto em uma noite; a fundação sim).

## 7. Deploy e validação
- [ ] Testes verdes + `tsc` + build do client A CADA fase (lição de hoje: vitest não pega erro de tipo).
- [ ] Deploy por fase (sistema pausado = janela segura).
- [ ] Smoke test pós-deploy: painel, /api/dashboard, status API do faturamento.

## 8. Comunicação
- [ ] Travar a conversa do Jorge no TechSAC (template) e usar o WhatsApp pra dúvidas/preview
      (autorizado por ele às 23h).
- [ ] Amanhã cedo: resumo do que subiu + o que depende de decisão dele
      (publicar flow v8, preço 19,90 vs 19,91, despausar com faixas ligadas).

## Fora do escopo desta noite (registrado pra não esquecer)
- Reversão do FPS 90 pra R$ 39,90: JÁ AGENDADA (01:00 + rede de segurança 08:00). Não mexer aqui.
- Vitrine da Queima de Inverno (barrinha/badge): decisão do Jorge de manhã.
- Extensão de PIX pra quem está conversando quando expira: ideia anotada, não pedida.
- Onboarding self-service de empresa nova: fase 2 do multi-tenant.
