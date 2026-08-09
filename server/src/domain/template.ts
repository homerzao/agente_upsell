// Payload do template de confirmação (com Flow) — puro e coberto por teste.
// GOTCHA 2: texto misto com ${data.x} NÃO interpola dentro do flow — bindings
// PUROS no flow; as frases compostas são montadas AQUI, no flow_action_data.
import { renderCopy } from '../lib/util.js';

export type DadosTemplate = {
  nome: string;           // primeiro nome
  nome_completo: string;
  numero: string;         // número do pedido
  email: string;
  endereco: string;
};

// Mesmo template, no formato da rota /api/v2/whatsapp/send_template do TechSAC.
// Ela cria a conversa já TRAVADA e devolve o conversation_id INTERNO — único
// jeito de obtê-lo (a API v1 não expõe) e sem ele não dá pra destravar depois.
export function montarTemplateTechSAC(args: {
  to: string;
  contactName: string;
  templateNome: string;
  flowToken: string;
  headerUrl?: string;
  headerMediaId?: string;
  copies: Record<string, string>;
  dados: DadosTemplate;
}): Record<string, unknown> {
  const meta = montarTemplateConfirma(args) as any;
  return {
    to_number: args.to,
    contact_name: args.contactName,
    template: { name: args.templateNome, language: { policy: 'deterministic', code: 'pt_BR' } },
    components: meta.template.components,
    lock_conversation: true, // a resposta fica com o funil, não abre sessão no SAC
  };
}

export function montarTemplateConfirma(args: {
  to: string;
  templateNome: string;
  flowToken: string; // "store:order_id"
  headerUrl?: string;
  headerMediaId?: string;
  copies: Record<string, string>;
  dados: DadosTemplate;
}): Record<string, unknown> {
  const { copies, dados } = args;
  const r = (chave: string) => renderCopy(copies[chave] ?? '', dados);
  return {
    to: args.to,
    type: 'template',
    template: {
      name: args.templateNome,
      language: { code: 'pt_BR' },
      components: [
        {
          type: 'header',
          parameters: [
            {
              type: 'image',
              // GOTCHA 6: media id EXPIRA (~30d) — preferir URL própria
              image: args.headerUrl ? { link: args.headerUrl } : { id: args.headerMediaId ?? '' },
            },
          ],
        },
        {
          type: 'body',
          parameters: [
            { type: 'text', text: dados.nome },
            { type: 'text', text: dados.numero },
          ],
        },
        {
          type: 'button',
          sub_type: 'flow',
          index: '0',
          parameters: [
            {
              type: 'action',
              action: {
                flow_token: args.flowToken,
                flow_action_data: {
                  saudacao: r('flow_saudacao'),
                  linha_pedido: r('flow_linha_pedido'),
                  linha_nome: r('flow_linha_nome'),
                  linha_email: r('flow_linha_email'),
                  linha_endereco: r('flow_linha_endereco'),
                  titulo_ticket: r('flow_titulo_ticket'),
                  corpo_corrigir: r('flow_corpo_corrigir'),
                  saudacao_ok: r('flow_saudacao_ok'),
                },
              },
            },
          ],
        },
      ],
    },
  };
}
