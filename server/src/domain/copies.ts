// Copies VALIDADAS em produção (portadas do agente_ecom — pedido e dinheiro real).
// São o default da oferta; o painel permite editar (versionado em ofertas_historico).
// Placeholders: {{nome}} {{nome_completo}} {{numero}} {{email}} {{endereco}}
//               {{produto}} {{preco}} {{minutos}} {{sku}} {{qtd}} {{valor}} {{charge_id}}

export const COPIES_DEFAULT: Record<string, string> = {
  // Texto do Flow vai TODO via flow_action_data (flow publicado é imutável;
  // bindings no flow são PUROS "${data.campo}" — frases compostas montadas AQUI).
  flow_saudacao: 'Olá, {{nome}}! ✨',
  flow_linha_pedido: 'Seu pedido #{{numero}} foi confirmado com sucesso. Confere os dados antes de seguirmos:',
  flow_linha_nome: '📌 Nome: {{nome_completo}}',
  flow_linha_email: '📧 E-mail: {{email}}',
  flow_linha_endereco: '📍 Endereço: {{endereco}}',
  flow_titulo_ticket: '🏆 {{nome}}, você desbloqueou o TICKET DOURADO',
  flow_corpo_corrigir: 'Sem problema, {{nome}} — nosso time vai seguir com o atendimento por aqui no WhatsApp pra ajustar o que precisar, antes do envio.',
  flow_saudacao_ok: 'Tudo certo, {{nome}}! ✅',

  // ===== Flow v8: tela do TICKET 100% dinâmica (multi-oferta) + tela de
  // CONFIRMAÇÃO (double-check antes de gerar o PIX). Os defaults reproduzem o
  // texto do Kit que estava CRAVADO no JSON do v7; a oferta nova (faixa < R$50)
  // define os dela nos copies próprios.
  flow_oferta_urgencia: '🚨 Essa oferta aparece UMA única vez, aqui nesta tela. Fechou sem pegar? Ela some pra sempre.',
  flow_oferta_intro: 'O que entra no seu pedido quando você toca no botão dourado: 👇',
  flow_oferta_bullets: '✅ Protetor Facial FPS 70 Clareador 50g\n✅ Sérum Multicorretivo Clareador 30ml\n✅ Sabonete Facial de Limpeza Profunda 120ml',
  flow_oferta_extras: '🚀 Frete prioritário: seu pedido fura a fila e sai na frente\n📦 Frete incluso: vai tudo junto, sem pagar nada a mais',
  flow_oferta_preco_linha: '💰 Separados, os 3 custam R$ 149,90. No Ticket Dourado: R$ 49,91.',
  flow_oferta_prazo_linha: '⏱️ Seu PIX chega aqui na conversa e vale 5 minutos. Passou, já era, a oferta não volta.',
  // Tela de conquista, não de burocracia (Jorge, 10/08): mostra o que a pessoa
  // GANHOU e quanto economiza, estilo Queima de Inverno. {{economia}} e
  // {{desconto_pct}} são CALCULADOS pelo servidor a partir de preco/preco_de —
  // oferta nova já nasce com a conta certa.
  // ⚠️ Texto de tela de FLOW não renderiza *negrito* (asterisco sai literal!):
  // ênfase aqui é CAIXA ALTA + emoji. Nas mensagens de sessão (msg_*) o
  // asterisco funciona normal.
  // COMPACTA de propósito (Jorge, screenshot 10/08): a tela inteira — título,
  // ganho, link de sair e botão — precisa caber SEM rolagem. Máximo 4 linhas.
  flow_confirma_titulo: '🏆 OFERTA ÚNICA DESBLOQUEADA!',
  flow_confirma_resumo: '✨ Kit Clareador COMPLETO — 3 produtos\n💸 De R$ {{preco_de}} por R$ {{preco}} ({{desconto_pct}}% OFF)\n💰 Você economiza R$ {{economia}} 🔥\n📦 No MESMO pedido, sem frete a mais',

  // Msg 1 do aceite: sai NA HORA (resposta instantânea), ANTES de criar o PIX.
  msg_aceite:
    '🏆 Ticket Dourado garantido, {{nome}}!\n\nSeu Kit Clareador completo por R$ {{preco}} entra no pedido assim que o PIX for pago.\n\n📦 Vai tudo junto no MESMO frete, sem pagar nada a mais de envio — e com *frete prioritário*: seu pedido fura a fila e sai na frente. 🚀\n\n⏱️ O código vale por {{minutos}} minutos. Depois disso ele expira e a oferta não volta.\n\nCopia o código PIX da próxima mensagem 👇',

  // Se a criação do PIX falhar DEPOIS da msg 1 (nunca deixar o cliente esperando código fantasma)
  msg_pix_instabilidade:
    'Ops, {{nome}}! Tivemos uma instabilidade pra gerar seu PIX agora. 😔 Nosso time já foi avisado — assim que normalizar, te mando o código por aqui. 💙',

  // Pré-resposta do "corrigir" (o agente IA assume a conversa a partir daqui)
  msg_corrigir:
    'Nosso time de atendimento já foi acionado, {{nome}}! 💬\n\n✅ Pode ficar tranquilo(a): seu pedido *#{{numero}}* NÃO será faturado até a correção ser feita — nada sai errado daqui.\n\nMe conta aqui mesmo o que precisa corrigir (nome, endereço ou e-mail) que ajustamos pra você antes do envio. 💙',

  // Confirmação pós-pagamento: o cliente PRECISA desse fechamento (🎉 + MESMO pedido + rastreio)
  msg_pago:
    '🎉 Pagamento confirmado, {{nome}}! Seu Ticket Dourado está garantido. 🏆\n\n✅ O Kit Clareador completo (sabonete + protetor FPS 70 + sérum) entra no MESMO pedido que você já fez — vai tudo junto, sem nenhum frete extra.\n\n📦 Assim que o pedido for faturado, a confirmação e o código de rastreio chegam por aqui no WhatsApp.\n\nObrigada pela confiança! 💛',

  // Anotação buscável no painel da Yampi (formato do contrato com a operação)
  anotacao_yampi:
    '✅ UPSELL WPP ACEITO E PAGO | {{produto}} (SKU {{sku}}) x{{qtd}} | R$ {{valor}} | PIX {{charge_id}} | ADICIONAR AO PEDIDO antes de faturar',

  // Descrição do item na cobrança Pagar.me
  pix_item_descricao: 'Ticket Dourado Hidrabene — Kit Clareador (3 produtos)',

  // Aceite fora da janela (cliente clicou depois que a oferta expirou — precisa de resposta)
  msg_aceite_tardio:
    'Poxa, {{nome}}! 😔 Essa oferta relâmpago era por tempo limitado e acabou de expirar.\n\nMas fica tranquila: seu pedido *#{{numero}}* está confirmado e segue normalmente pro faturamento. O código de rastreio chega por aqui no WhatsApp. 💙',

  // Última chance antes do prazo ANUNCIADO acabar. No piloto real (09/08),
  // 2 de 3 aceites viraram expirado: a pessoa aceita e some sem um empurrão.
  msg_lembrete_pix:
    '⏱️ {{nome}}, seu código PIX vence em {{minutos_restantes}} minutos!\n\nÚltima chance de garantir o Kit Clareador por R$ 49,91 dentro do mesmo pedido, sem frete extra.\n\nÉ só colar aqui em cima no app do banco 💛',

  // Página do PIX (10/08): o mesmo link vai no lembrete dos 7 min, no reenvio
  // e na tool enviar_pagina_pix. Copy NEUTRA de propósito — a primeira versão
  // dizia "se o copia e cola não funcionar" e saiu para uma cliente que tinha
  // dito "já foi pago" (Gislaine, 21:38), fora de contexto. Serve pros dois casos.
  msg_pagina_pix:
    'Se preferir, {{nome}}, dá pra pagar por esta página segura: o código está inteiro lá e um botão copia ele sozinho 👇\n\n{{link}}',
  // Corpo da mensagem-botão (cta_url) que sai logo abaixo do link solto
  msg_pagina_pix_cta: 'Ou toca aqui embaixo que abre direto 👇',

  // Venceu de verdade (prazo real, maior que o anunciado). Tom POSITIVO: o
  // cliente comprou, então agradece e tranquiliza — não é hora de lamentar.
  msg_pix_expirado:
    'Tudo certo por aqui, {{nome}}! Seu pedido *#{{numero}}* está confirmado e já segue pro faturamento 📦\n\nO prazo do Ticket Dourado encerrou, mas isso não muda nada no seu pedido: assim que sair, o código de rastreio chega por aqui.\n\nObrigada pela compra! 💛',

  // Despedida no fechamento do flow (recusou / confirmou terminal / expirada) — pedido do Jorge
  msg_despedida:
    'Tudo certo, {{nome}}! ✅ Seu pedido *#{{numero}}* está confirmado e já segue pro faturamento.\n\n📦 Assim que for enviado, o código de rastreio chega por aqui no WhatsApp.\n\nObrigada pela preferência! 💙',

  // Avisos do fluxo de correção com aprovação (novos neste sistema)
  msg_correcao_aplicada:
    'Prontinho, {{nome}}! ✅ Já ajustamos aqui: {{resumo}}.\n\nSeu pedido *#{{numero}}* segue pro faturamento com os dados certinhos. Qualquer coisa é só chamar! 💙',
  msg_correcao_rejeitada:
    '{{nome}}, sobre o ajuste que você pediu: vamos precisar confirmar alguns detalhes com você antes de aplicar. Nosso time de atendimento continua por aqui com você. 💙',
};

export const OFERTA_DEFAULT = {
  nome: 'Kit Clareador Completo',
  sku_yampi: '2133823',
  preco: 49.91,
  preco_de: 149.9,
  qty: 1, // 1 kit = 3 produtos
};
