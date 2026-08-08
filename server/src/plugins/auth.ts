// Autenticação: sessão server-side (painel) + Bearer BACKEND_TOKEN (APIs internas).
// CSRF: mutações via sessão exigem X-CSRF-Token (emitido no login); Bearer é isento.
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { Config } from '../config.js';

export const COOKIE_SESSAO = 'waup_sess';
const TTL_SESSAO_SEG = 7 * 24 * 3600;

export type Sessao = { user: string; csrf: string };

export function criarAuth(cfg: Config, redis: Redis) {
  const chave = (id: string) => `waup:sess:${id}`;

  async function criarSessao(user: string): Promise<{ id: string; csrf: string }> {
    const id = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(24).toString('hex');
    await redis.set(chave(id), JSON.stringify({ user, csrf }), 'EX', TTL_SESSAO_SEG);
    return { id, csrf };
  }

  async function lerSessao(req: FastifyRequest): Promise<Sessao | null> {
    const raw = (req.cookies ?? {})[COOKIE_SESSAO];
    if (!raw) return null;
    const un = req.unsignCookie(raw);
    if (!un.valid || !un.value) return null;
    const j = await redis.get(chave(un.value));
    if (!j) return null;
    await redis.expire(chave(un.value), TTL_SESSAO_SEG); // sliding TTL
    try {
      return JSON.parse(j) as Sessao;
    } catch {
      return null;
    }
  }

  async function destruirSessao(req: FastifyRequest): Promise<void> {
    const raw = (req.cookies ?? {})[COOKIE_SESSAO];
    if (!raw) return;
    const un = req.unsignCookie(raw);
    if (un.valid && un.value) await redis.del(chave(un.value));
  }

  const ehBearerMaster = (req: FastifyRequest): boolean =>
    (req.headers.authorization ?? '') === `Bearer ${cfg.BACKEND_TOKEN}`;

  const ehBearerStatus = (req: FastifyRequest): boolean =>
    Boolean(cfg.STATUS_TOKEN) && (req.headers.authorization ?? '') === `Bearer ${cfg.STATUS_TOKEN}`;

  // preHandler das rotas administrativas (painel + API interna)
  async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (ehBearerMaster(req)) {
      (req as any).adminUser = 'api';
      return;
    }
    const sess = await lerSessao(req);
    if (!sess) {
      reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
    const mutacao = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutacao && req.headers['x-csrf-token'] !== sess.csrf) {
      reply.code(403).send({ error: 'csrf' });
      return reply;
    }
    (req as any).adminUser = sess.user;
  }

  return { criarSessao, lerSessao, destruirSessao, requireAdmin, ehBearerMaster, ehBearerStatus };
}

export type Auth = ReturnType<typeof criarAuth>;
