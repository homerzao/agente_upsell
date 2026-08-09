// Meta WhatsApp Cloud API.
// GOTCHA 7: waSendRaw LANÇA em !ok — TODO caller precisa de catch com log em
// wa_events (falha silenciosa de envio foi o pior bug de achar).
import crypto from 'node:crypto';

export type MetaService = ReturnType<typeof criarMeta>;

type FetchFn = typeof fetch;

export function criarMeta(
  cfg: { METAWA_TOKEN: string; METAWA_PHONE_ID: string; META_APP_SECRET: string },
  fetchFn: FetchFn = fetch,
) {
  async function waSendRaw(payload: Record<string, unknown>): Promise<any> {
    const r = await fetchFn(`https://graph.facebook.com/v21.0/${cfg.METAWA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.METAWA_TOKEN}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`meta ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }

  // Mensagem de sessão (janela de 24h aberta pela interação do cliente no flow).
  const enviarTexto = (to: string, body: string) =>
    waSendRaw({ to, type: 'text', text: { body } });

  // Valida X-Hub-Signature-256 do webhook (quando META_APP_SECRET configurado).
  function validarAssinatura(rawBody: string, header: string | undefined): boolean {
    if (!cfg.META_APP_SECRET) return true; // sem secret configurado, não valida
    if (!header) return false;
    const esperado = 'sha256=' + crypto.createHmac('sha256', cfg.META_APP_SECRET).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(esperado));
    } catch {
      return false;
    }
  }

  // Baixa mídia do WhatsApp: o webhook traz só o media_id — é preciso pedir a
  // URL e depois baixar com o mesmo token (a URL não é pública).
  async function baixarMidia(mediaId: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
    const meta = await fetchFn(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${cfg.METAWA_TOKEN}` },
    });
    const j: any = await meta.json().catch(() => ({}));
    if (!meta.ok || !j.url) throw new Error(`media ${meta.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const bin = await fetchFn(j.url, { headers: { Authorization: `Bearer ${cfg.METAWA_TOKEN}` } });
    if (!bin.ok) throw new Error(`download media ${bin.status}`);
    return { bytes: await bin.arrayBuffer(), mime: j.mime_type ?? 'application/octet-stream' };
  }

  return { waSendRaw, enviarTexto, validarAssinatura, baixarMidia };
}
