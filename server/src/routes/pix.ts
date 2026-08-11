// Rotas PÚBLICAS da página do PIX — sem autenticação de propósito: o acesso
// É o token (128 bits opacos, coluna pix_pagina_token). Segurança:
// - formato do token validado por regex ANTES de tocar o banco;
// - rate-limit por IP em todas as rotas (força bruta em 2^128 é inviável,
//   o limite é só pra não deixar martelar);
// - resposta idêntica pra token inexistente (anti-enumeração, nada de 404 com dica);
// - headers: noindex, no-store, CSP travada (só inline próprio + connect self);
// - a página NUNCA mostra código de PIX morto (estado != vivo → sem código).
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getOferta, logEvento, type FunilCtx } from '../domain/funil.js';
import { primeiroNome } from '../lib/util.js';
import {
  estadoPagina,
  renderPaginaNaoEncontrada,
  renderPaginaPix,
  PAGINA_PIX_RETENCAO_DIAS,
  type EstadoPagina,
} from '../domain/pagina-pix.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

// Quem abriu: PESSOA de verdade, pré-carregamento do WhatsApp/Meta (acontece
// SOZINHO quando a mensagem é enviada — inflava a métrica de "abriu"), ou
// ferramenta (curl do monitor/nossos testes). Sem isso "aberturas" mistura
// robô com cliente e a análise da página fica mentirosa.
export function classificarUA(ua: string): 'pessoa' | 'preview' | 'robo' {
  const u = ua.toLowerCase();
  if (!u) return 'robo';
  if (/facebookexternalhit|whatsapp|facebot|meta-externalagent|bot|crawler|spider|preview/.test(u)) return 'preview';
  if (/curl|wget|python-requests|node-fetch|okhttp|go-http|postman|axios|libwww/.test(u)) return 'robo';
  if (/mozilla|safari|chrome|firefox|opera|edg/.test(u)) return 'pessoa';
  return 'robo';
}

// Identidade PSEUDÔNIMA do visitante (nunca o IP cru): hash com salt do
// servidor, 12 chars. Serve pra (a) desduplicar reload do mesmo aparelho e
// (b) reconhecer o operador — quem abre páginas de VÁRIOS pedidos diferentes
// não é cliente, é a gente testando.
function visitanteHash(cfgSalt: string, ip: string, ua: string): string {
  return createHash('sha256').update(`${cfgSalt}|${ip}|${ua.slice(0, 120)}`).digest('base64url').slice(0, 12);
}

const brl = (n: number) => n.toFixed(2).replace('.', ',');

function headersPagina(reply: any): void {
  reply.header('content-type', 'text/html; charset=utf-8');
  reply.header('cache-control', 'no-store');
  reply.header('x-robots-tag', 'noindex, nofollow');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

// Token VELHO não resolve mais: cai na página padrão como se não existisse.
// (O sweeper zera a coluna depois; isto aqui garante o prazo mesmo antes dele.)
// Sandbox fica de fora — é o caso de demonstração, não expira.
async function buscarPorToken(ctx: FunilCtx, token: string): Promise<any | null> {
  if (!TOKEN_RE.test(token)) return null;
  const r = await ctx.db.query(
    `SELECT * FROM wa_upsell
      WHERE pix_pagina_token=$1
        AND (store='sandbox' OR COALESCE(pix_enviado_em, criado_em) > now() - ($2 || ' days')::interval)`,
    [token, PAGINA_PIX_RETENCAO_DIAS],
  );
  return r.rows[0] ?? null;
}

// Estado do polling: query MÍNIMA (4 colunas, índice do token) — roda a cada
// 15s por aba aberta, então é o ponto quente da página em dia de volume.
async function estadoPorToken(ctx: FunilCtx, token: string): Promise<EstadoPagina | null> {
  if (!TOKEN_RE.test(token)) return null;
  const r = await ctx.db.query(
    `SELECT status, etapa, pix_codigo, pix_expira_em FROM wa_upsell
      WHERE pix_pagina_token=$1
        AND (store='sandbox' OR COALESCE(pix_enviado_em, criado_em) > now() - ($2 || ' days')::interval)`,
    [token, PAGINA_PIX_RETENCAO_DIAS],
  );
  return r.rows[0] ? estadoPagina(r.rows[0]) : null;
}

// UMA linha por pedido por evento (TTL da retenção): sem isso, recarregar a
// página vira log novo e a tabela cresce com o volume de pedidos. Redis fora
// do ar = registra (perder métrica é pior que uma linha a mais).
async function primeiraVez(ctx: FunilCtx, store: string, orderId: number, evento: string): Promise<boolean> {
  try {
    const r = await ctx.redis.set(
      `waup:pgpix:${store}:${orderId}:${evento}`, '1', 'EX', PAGINA_PIX_RETENCAO_DIAS * 86400, 'NX',
    );
    return r === 'OK';
  } catch {
    return true;
  }
}

export function pixRoutes(app: FastifyInstance, ctx: FunilCtx): void {
  // A página em si (server-rendered, autocontida)
  app.get(
    '/pix/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const token = String((req.params as any).token ?? '');
      const row = await buscarPorToken(ctx, token);
      headersPagina(reply);
      if (!row) return reply.code(200).send(renderPaginaNaoEncontrada());

      const estado: EstadoPagina = estadoPagina(row);
      const oferta = await getOferta(ctx, row.oferta_id);
      const temDe = oferta?.preco_de != null && oferta.preco_de > (oferta?.preco ?? 0);
      // Métrica própria (pedido do Jorge): quantos ABRIRAM, por estado —
      // carimbando QUEM abriu (pessoa/preview do WhatsApp/robô) e um hash do
      // visitante, senão o número mistura cliente com pré-carregamento da Meta
      // e com os testes do Jorge (10/08).
      const ua = String(req.headers['user-agent'] ?? '');
      const quem = classificarUA(ua);
      // Só GENTE e só a PRIMEIRA vez: pré-carregamento do WhatsApp, robô e
      // reload não viram linha no banco (a métrica que interessa é "abriu?").
      if (quem === 'pessoa' && (await primeiraVez(ctx, row.store, row.order_id, 'aberta'))) {
        await logEvento(ctx, row.store, {
          evento: 'pagina_pix_aberta',
          order_id: row.order_id,
          estado,
          quem,
          visitante: visitanteHash(ctx.cfg.SESSION_SECRET, String(req.ip ?? ''), ua),
        }).catch(() => {});
      }
      return reply.code(200).send(
        renderPaginaPix({
          estado,
          token,
          nome: primeiroNome(row.customer_name ?? ''),
          produto: oferta?.nome ?? 'Sua oferta Hidrabene',
          preco: oferta ? brl(Number(oferta.preco)) : '',
          precoDe: temDe ? brl(Number(oferta!.preco_de)) : '',
          economia: temDe ? brl(Number(oferta!.preco_de) - Number(oferta!.preco)) : '',
          descontoPct: temDe ? String(Math.round((1 - Number(oferta!.preco) / Number(oferta!.preco_de)) * 100)) : '',
          codigo: estado === 'vivo' ? String(row.pix_codigo) : '',
          expiraEmIso: estado === 'vivo' ? new Date(row.pix_expira_em).toISOString() : '',
        }),
      );
    },
  );

  // Polling da página (10s): só o estado — nunca dados do pedido
  app.get(
    '/pix/:token/status',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const estado = await estadoPorToken(ctx, String((req.params as any).token ?? ''));
      reply.header('cache-control', 'no-store');
      return { estado: estado ?? 'expirado' };
    },
  );

  // sendBeacon do botão copiar (uma vez por abertura; corpo vazio)
  app.post(
    '/pix/:token/copiou',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const row = await buscarPorToken(ctx, String((req.params as any).token ?? ''));
      if (row) {
        const ua = String(req.headers['user-agent'] ?? '');
        const quem = classificarUA(ua);
        if (await primeiraVez(ctx, row.store, row.order_id, 'copiou')) {
          await logEvento(ctx, row.store, {
            evento: 'pagina_pix_copiou',
            order_id: row.order_id,
            quem,
            visitante: visitanteHash(ctx.cfg.SESSION_SECRET, String(req.ip ?? ''), ua),
          }).catch(() => {});
        }
      }
      return reply.code(204).send();
    },
  );
}
