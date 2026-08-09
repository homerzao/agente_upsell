// Processamento do webhook da Meta chamado DIRETO (sem n8n na frente).
// O webhook do número recebe o firehose inteiro (SAC, status de tudo, reentregas);
// requisito do Jorge: "filtragem, limpeza, guardar só conversa do que tem no
// contexto ali pós msg, só do lead que envia". Só persiste o que passa no filtro:
//   1. nfm_reply com flow_token parseável (resposta de flow)
//   2. statuses que batem com um template_msg_id nosso (update; sem log)
//   3. texto inbound de fone com row em contexto ativo -> injeta no Chatwoot
// Todo o resto: 200 e descarte, sem gravar.
import { foneBr } from '../lib/util.js';
import { parseFlowToken } from './estados.js';
import { processarMensagemCliente, type AgenteCtx } from './agente/agente.js';
import {
  buscarRowContextoAtivo, criarConversaChatwoot, getDisparosConfig, logEvento,
  registrarResposta, type FunilCtx,
} from './funil.js';

const TTL_WAMID_SEG = 7 * 24 * 3600;
// Claim inicial CURTO: se o processo morrer no meio (deploy!), o claim expira e
// a reentrega da Meta reprocessa. Só vira 7 dias DEPOIS do processamento ok.
// (Bug real de 08/08: mensagem do Jorge caiu na janela do deploy, o container
// velho reivindicou o wamid e morreu — a reentrega foi descartada pra sempre.)
const TTL_CLAIM_SEG = 60;

// Dedup por wamid: a Meta reentrega webhooks — repetido não processa de novo.
export async function reivindicarWamid(ctx: FunilCtx, wamid: string): Promise<boolean> {
  if (!wamid) return true; // sem id: processa (não dá pra dedupar)
  const r = await ctx.redis.set(`waup:wamid:${wamid}`, '1', 'EX', TTL_CLAIM_SEG, 'NX');
  return r !== null && r !== undefined && r !== 0; // 'OK' = somos os primeiros
}

// Processou com sucesso: estende o claim pro TTL cheio (dedup de reentrega tardia)
export async function confirmarWamid(ctx: FunilCtx, wamid: string): Promise<void> {
  if (wamid) await ctx.redis.expire(`waup:wamid:${wamid}`, TTL_WAMID_SEG);
}

// Processamento FALHOU: libera o claim pra reentrega da Meta tentar de novo
export async function liberarWamid(ctx: FunilCtx, wamid: string): Promise<void> {
  if (wamid) await ctx.redis.del(`waup:wamid:${wamid}`);
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
// Áudio e imagem viram TEXTO antes de chegar no agente (Whisper e visão).
// Sem isso o cliente mandava um áudio e a IA nem sabia que existiu.
async function midiaParaTexto(ctx: AgenteCtx, msg: any, conversaId?: number | null): Promise<string> {
  const tipo = String(msg.type ?? '');
  const media = msg.audio ?? msg.voice ?? msg.image ?? msg.document ?? null;
  if (!media?.id || !ctx.openai) return '';
  try {
    const { bytes, mime } = await ctx.meta.baixarMidia(String(media.id));
    // Guarda o arquivo pro HUMANO ver no painel (a descrição é pro contexto da
    // IA; quem vai atender precisa ver a imagem/ouvir o áudio). Limite de 8MB.
    let midiaId: number | null = null;
    if (conversaId && bytes.byteLength <= 8 * 1024 * 1024) {
      midiaId = (
        await ctx.db.query(
          `INSERT INTO midias (conversa_id, tipo, mime, bytes) VALUES ($1,$2,$3,$4) RETURNING id`,
          [conversaId, tipo === 'image' ? 'image' : 'audio', mime, Buffer.from(bytes)],
        ).then((r: any) => r.rows[0]?.id ?? null).catch(() => null)
      );
    }
    const marca = midiaId ? ` [midia:${midiaId}]` : '';
    if (tipo === 'audio' || tipo === 'voice') {
      const texto = await ctx.openai.transcrever(bytes, mime);
      return texto ? `[áudio do cliente, transcrito]${marca} ${texto}` : '';
    }
    if (tipo === 'image') {
      const desc = await ctx.openai.descreverImagem(bytes, mime, String(msg.image?.caption ?? ''));
      const legenda = String(msg.image?.caption ?? '').trim();
      return desc ? `[imagem enviada pelo cliente]${marca} ${desc}${legenda ? `\n(legenda: ${legenda})` : ''}` : '';
    }
    return '';
  } catch (e) {
    await logEvento(ctx, 'hidrabene', {
      erro: 'midia_falhou',
      tipo,
      detalhe: String((e as Error).message).slice(0, 200),
    });
    // O agente precisa saber que ALGO chegou, mesmo sem conseguir ler
    return tipo === 'audio' || tipo === 'voice'
      ? '[o cliente mandou um áudio que não consegui ouvir — peça pra ele escrever]'
      : '[o cliente mandou uma imagem que não consegui abrir — pergunte o que é]';
  }
}

async function processarTextoInbound(ctx: AgenteCtx, msg: any): Promise<void> {
  const fone = String(msg.from ?? '');
  const soTexto = String(msg.text?.body ?? '').trim();
  // precisa da row ANTES da mídia: a mídia é guardada ligada à conversa
  const row = soTexto ? await buscarRowContextoAtivo(ctx, fone) : await buscarRowContextoAtivo(ctx, fone);
  if (!fone || !row) return; // fora de contexto: SAC comum, descarta sem gravar
  const conversaId = (
    await ctx.db.query('SELECT id FROM conversas WHERE wa_upsell_id=$1 ORDER BY id DESC LIMIT 1', [row.id])
  ).rows[0]?.id ?? null;
  const texto = soTexto || (await midiaParaTexto(ctx, msg, conversaId));
  if (!texto) return;
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
        const wamid = String(msg.id ?? '');
        if (!(await reivindicarWamid(ctx, wamid))) continue; // reentrega
        try {
          if (msg.interactive?.nfm_reply) {
            await processarNfmReply(ctx, msg);
          } else if (['text', 'audio', 'voice', 'image'].includes(String(msg.type)) || msg.text?.body) {
            // áudio e imagem entram aqui e viram texto (Whisper / visão)
            await processarTextoInbound(ctx, msg);
          }
          // demais tipos (sticker, reação, localização): descarte silencioso
          await confirmarWamid(ctx, wamid);
        } catch (e) {
          // devolve o claim: a reentrega da Meta reprocessa em vez de perder a msg
          await liberarWamid(ctx, wamid);
          await logEvento(ctx, 'hidrabene', {
            erro: 'processar_msg_meta_falhou',
            wamid,
            detalhe: String((e as Error).message).slice(0, 300),
          });
        }
      }
      // Status de entrega: SÓ os que batem com um template nosso (o UPDATE é o
      // filtro); os demais são descartados sem log.
      for (const st of ch.value?.statuses ?? []) {
        const tipo = String(st.status);
        if (!st.id || !['delivered', 'read'].includes(tipo)) continue;
        // Carimba QUANDO entregou e QUANDO leu (a Meta manda epoch em segundos).
        // COALESCE: fica o PRIMEIRO de cada — reentrega não reescreve a hora.
        const quando = st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : new Date().toISOString();
        const r = await ctx.db.query(
          `UPDATE wa_upsell SET
             disparo_status='entregue',
             entregue_em=COALESCE(entregue_em, $2::timestamptz),
             lido_em=CASE WHEN $3 THEN COALESCE(lido_em, $2::timestamptz) ELSE lido_em END,
             atualizado_em=now()
           WHERE template_msg_id=$1
           RETURNING order_id`,
          [st.id, quando, tipo === 'read'],
        );
        // O disparo pela rota do TechSAC NÃO devolve o wamid, então a maioria
        // das rows não tem template_msg_id e nunca casaria por id (descoberto
        // 09/08: 187 de 189 sem wamid). Casa pelo DESTINATÁRIO: a row mais
        // recente daquele fone disparada na última hora. Match por DDD +
        // últimos 8 dígitos (o wa_id vem sem o nono).
        if (!r.rows.length && st.recipient_id) {
          const fone = foneBr(String(st.recipient_id));
          await ctx.db.query(
            `UPDATE wa_upsell SET
               disparo_status='entregue',
               entregue_em=COALESCE(entregue_em, $2::timestamptz),
               lido_em=CASE WHEN $3 THEN COALESCE(lido_em, $2::timestamptz) ELSE lido_em END,
               atualizado_em=now()
             WHERE id = (
               SELECT id FROM wa_upsell
               WHERE right(customer_phone, 8) = right($1, 8)
                 AND substring(customer_phone from 3 for 2) = substring($1 from 3 for 2)
                 AND disparado_em > now() - interval '1 hour'
               ORDER BY disparado_em DESC LIMIT 1
             )`,
            [fone, quando, tipo === 'read'],
          );
        }
      }
    }
  }
}
