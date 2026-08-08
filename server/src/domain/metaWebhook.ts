// Processamento do webhook da Meta chamado DIRETO (sem n8n na frente).
// O webhook do número recebe o firehose inteiro (SAC, status de tudo, reentregas);
// requisito do Jorge: "filtragem, limpeza, guardar só conversa do que tem no
// contexto ali pós msg, só do lead que envia". Só persiste o que passa no filtro:
//   1. nfm_reply com flow_token parseável (resposta de flow)
//   2. statuses que batem com um template_msg_id nosso (update; sem log)
//   3. texto inbound de fone com row em contexto ativo -> injeta no Chatwoot
// Todo o resto: 200 e descarte, sem gravar.
import { parseFlowToken } from './estados.js';
import { processarMensagemCliente, type AgenteCtx } from './agente/agente.js';
import {
  buscarRowContextoAtivo, criarConversaChatwoot, getDisparosConfig, logEvento,
  registrarResposta, type FunilCtx,
} from './funil.js';

const TTL_WAMID_SEG = 7 * 24 * 3600;

// Dedup por wamid: a Meta reentrega webhooks — repetido não processa de novo.
export async function reivindicarWamid(ctx: FunilCtx, wamid: string): Promise<boolean> {
  if (!wamid) return true; // sem id: processa (não dá pra dedupar)
  const r = await ctx.redis.set(`waup:wamid:${wamid}`, '1', 'EX', TTL_WAMID_SEG, 'NX');
  return r !== null && r !== undefined && r !== 0; // 'OK' = somos os primeiros
}

async function processarNfmReply(ctx: FunilCtx, msg: any): Promise<void> {
  let resp: any = {};
  try {
    resp = JSON.parse(msg.interactive?.nfm_reply?.response_json ?? '{}');
  } catch {
    return;
  }
  const ref = parseFlowToken(resp.flow_token);
  if (!ref) return; // sem token nosso: não é do funil
  await logEvento(ctx, ref.store, { origem: 'meta', tipo: 'nfm_reply', order_id: ref.orderId, resposta: resp });
  await registrarResposta(ctx, ref.store, ref.orderId, resp);
}

// Texto inbound de lead em contexto ativo -> injeta na conversa do Chatwoot
// (a Meta não entrega mais pro Chatwoot sozinha) e chama o agente IA DIRETO
// daqui — caminho único, sem webhook do Chatwoot (decisão do Jorge 08/08:
// "chatwoot não precisa de webhook, já que vamos captar da meta direto").
// A injeção é só espelho pro SAC ver a thread; falha nela não cala o agente.
async function processarTextoInbound(ctx: AgenteCtx, msg: any): Promise<void> {
  const fone = String(msg.from ?? '');
  const texto = String(msg.text?.body ?? '').trim();
  if (!fone || !texto) return;
  const row = await buscarRowContextoAtivo(ctx, fone);
  if (!row) return; // fora de contexto: SAC comum, descarta sem gravar
  await logEvento(ctx, row.store, { origem: 'meta', tipo: 'msg_cliente', order_id: row.order_id, wamid: msg.id ?? null });
  if (!ctx.chatwoot) return; // sem Chatwoot o agente não tem por onde responder
  const cfgd = await getDisparosConfig(ctx);
  let convId: number | null = null;
  try {
    // A fala do CLIENTE chega nativa no TechSAC (canal próprio dele) — NÃO
    // espelhar (Jorge, 08/08: "nota interna não é pro que o cliente fala, é pra
    // o que o agente fala com o cliente"). Aqui só garantimos a conversa.
    convId = await criarConversaChatwoot(ctx, row, cfgd.modo);
  } catch (e) {
    await logEvento(ctx, row.store, {
      erro: 'conversa_chatwoot_falhou',
      order_id: row.order_id,
      detalhe: String((e as Error).message).slice(0, 300),
    });
  }
  if (!convId) return;
  // Agente IA processa a mensagem AQUI (gatilho = webhook da Meta, não o do
  // Chatwoot). Guardas do agente valem iguais: modo test, humano assumiu, etc.
  try {
    await processarMensagemCliente(ctx, convId, fone, texto);
  } catch (e) {
    await logEvento(ctx, row.store, {
      erro: 'agente_processamento_falhou',
      order_id: row.order_id,
      detalhe: String((e as Error).message).slice(0, 300),
    });
  }
}

export async function processarWebhookMeta(ctx: AgenteCtx, body: any): Promise<void> {
  // Formato direto (compat n8n): {flow_token, ...respostas}
  if (body?.flow_token && !body?.entry) {
    const ref = parseFlowToken(body.flow_token);
    if (ref) {
      await logEvento(ctx, ref.store, { origem: 'meta', tipo: 'nfm_reply_forward', order_id: ref.orderId, resposta: body });
      await registrarResposta(ctx, ref.store, ref.orderId, body);
    }
    return;
  }
  for (const entry of body?.entry ?? []) {
    for (const ch of entry.changes ?? []) {
      for (const msg of ch.value?.messages ?? []) {
        if (!(await reivindicarWamid(ctx, String(msg.id ?? '')))) continue; // reentrega
        if (msg.interactive?.nfm_reply) {
          await processarNfmReply(ctx, msg);
        } else if (msg.type === 'text' || msg.text?.body) {
          await processarTextoInbound(ctx, msg);
        }
        // demais tipos (mídia, reação, etc.): descarte silencioso
      }
      // Status de entrega: SÓ os que batem com um template nosso (o UPDATE é o
      // filtro); os demais são descartados sem log.
      for (const st of ch.value?.statuses ?? []) {
        if (['delivered', 'read'].includes(String(st.status)) && st.id) {
          await ctx.db.query(
            `UPDATE wa_upsell SET disparo_status='entregue', atualizado_em=now()
             WHERE template_msg_id=$1 AND disparo_status='enviado'`,
            [st.id],
          );
        }
      }
    }
  }
}
