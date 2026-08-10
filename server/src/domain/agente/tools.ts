// Tools do agente IA — o modelo só age através delas (guardrail estrutural).
import type { ToolDef } from '../../services/openai.js';
import { mascararCpf, num, valorBr } from '../../lib/util.js';
import { registrarCorrecao, type CamposCorrecao } from '../correcoes.js';
import { encaminharHumano } from '../handoff.js';
import { getRow, logEvento, normalizarPedidoYampi, reenviarPix, type FunilCtx } from '../funil.js';
import type { WaUpsellRow } from '../tipos.js';

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'consultar_pedido',
      description: 'Dados completos e atuais do pedido na Yampi (itens, valores, endereço, status, rastreio).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'status_oferta',
      description: 'Etapa atual do funil da oferta, validade do PIX e status de pagamento.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reenviar_pix',
      description: 'Reenvia o código PIX (se ainda válido) ou gera um novo (se expirou) quando o cliente quer pagar a oferta.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_correcao',
      description:
        'Registra uma correção de dados JÁ CONFIRMADA com o cliente. Vai para aprovação humana antes de ser aplicada. Informe apenas os campos que mudam. ' +
        'PROIBIDO corrigir cidade, UF ou CEP (muda o frete): nesses casos NÃO chame esta ferramenta — avise o cliente e use encaminhar_humano.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome completo corrigido' },
          email: { type: 'string', description: 'E-mail corrigido' },
          endereco: {
            type: 'object',
            description: 'Somente os campos do endereço que mudam. Cidade/UF/CEP são PROIBIDOS (alteram o frete).',
            properties: {
              street: { type: 'string' },
              number: { type: 'string' },
              complement: { type: 'string' },
              neighborhood: { type: 'string' },
              receiver: { type: 'string', description: 'Nome de quem recebe' },
            },
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recusar_oferta',
      description:
        'Use quando o cliente disser POR MENSAGEM que não quer a oferta ("não, obrigada", "deixa pra próxima", "não tenho interesse"). Fecha a oferta na hora: para o lembrete de PIX e o aviso de expiração, que soariam insistentes com quem já recusou. Não usa isso se ele só tirou dúvida.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'O que o cliente disse, em poucas palavras' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'encaminhar_humano',
      description: 'Transfere a conversa para o time humano, com o motivo e um resumo do que o cliente precisa.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'Motivo curto (ex.: pediu humano, reembolso, fora do escopo)' },
          resumo: { type: 'string', description: 'Resumo da conversa e do que falta resolver' },
        },
        required: ['motivo', 'resumo'],
      },
    },
  },
];

// Executa uma tool; retorno vira o tool result (string JSON) da conversa.
export async function executarTool(
  ctx: FunilCtx,
  row: WaUpsellRow,
  conversa: { id: number; chatwoot_conversation_id: number | null },
  nome: string,
  args: Record<string, any>,
): Promise<{ resultado: unknown; handoff: boolean }> {
  switch (nome) {
    case 'consultar_pedido': {
      const pedido = await ctx.yampi.getOrder(row.order_id);
      const p = normalizarPedidoYampi(pedido);
      const items = pedido.items?.data ?? pedido.items ?? [];
      return {
        handoff: false,
        resultado: {
          numero: p.numero,
          status: p.status,
          cliente: { nome: p.nome, email: p.email, cpf_mascarado: mascararCpf(p.cpf) },
          endereco: p.endereco,
          itens: items.map((it: any) => ({
            titulo: it.sku?.data?.title ?? it.item_title ?? it.title ?? '',
            sku: it.sku?.data?.sku ?? null,
            qtd: it.quantity ?? 1,
            preco: num(it.price),
          })),
          total: num(pedido.value_total),
          frete: num(pedido.value_shipment ?? pedido.shipment_value),
          rastreio: pedido.shipment?.data?.tracking_code ?? pedido.track_code ?? null,
        },
      };
    }
    case 'status_oferta': {
      const atual = await getRow(ctx, row.store, row.order_id);
      const pg = await ctx.db.query(
        'SELECT valor, pago_em FROM wa_upsell_pagamentos WHERE store=$1 AND order_id=$2 ORDER BY id DESC LIMIT 1',
        [row.store, row.order_id],
      );
      const pixVivo = Boolean(
        atual?.etapa === 'pix_enviado' && atual.pix_expira_em && new Date(atual.pix_expira_em) > new Date(),
      );
      return {
        handoff: false,
        resultado: {
          etapa: atual?.etapa,
          status: atual?.status,
          pix: atual?.pix_charge_id
            ? { ativo: pixVivo, expira_em: atual?.pix_expira_em }
            : null,
          pagamento: pg.rows[0] ? { valor: valorBr(Number(pg.rows[0].valor)), pago_em: pg.rows[0].pago_em } : null,
        },
      };
    }
    case 'reenviar_pix': {
      const r = await reenviarPix(ctx, row.store, row.order_id);
      return { handoff: false, resultado: r };
    }
    case 'registrar_correcao': {
      const campos: CamposCorrecao = {
        nome: args.nome || undefined,
        email: args.email || undefined,
        endereco: args.endereco && Object.keys(args.endereco).length ? args.endereco : undefined,
      };
      const r = await registrarCorrecao(ctx, row.store, row.order_id, campos);
      return { handoff: false, resultado: r };
    }
    case 'recusar_oferta': {
      // Cliente recusou POR MENSAGEM. Sem isso o PIX seguia vivo e ele ainda
      // levava lembrete e aviso de expiração — insistindo com quem já disse não
      // (aconteceu com uma cliente no piloto, 09/08). Nunca mexe em 'pago'.
      const fechou = await ctx.db.query(
        `UPDATE wa_upsell SET status='closed', etapa='recusado', atualizado_em=now()
         WHERE store=$1 AND order_id=$2 AND status='open' AND etapa <> 'pago'
         RETURNING order_id`,
        [row.store, row.order_id],
      );
      await logEvento(ctx, row.store, {
        evento: 'recusa_por_mensagem',
        order_id: row.order_id,
        motivo: String(args.motivo ?? '').slice(0, 200),
        fechou: fechou.rows.length > 0,
      });
      return {
        handoff: false,
        resultado: { ok: true, oferta_encerrada: fechou.rows.length > 0 },
      };
    }
    case 'encaminhar_humano': {
      await encaminharHumano(ctx, conversa, String(args.motivo ?? 'solicitado'), String(args.resumo ?? ''));
      return { handoff: true, resultado: { ok: true, transferido: true } };
    }
    default:
      return { handoff: false, resultado: { erro: `tool desconhecida: ${nome}` } };
  }
}
