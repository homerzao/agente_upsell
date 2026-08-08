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
