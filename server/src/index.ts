import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { getPool, closePool } from './db/pool.js';
import { getRedis, closeRedis } from './db/redis.js';
import { migrate } from './db/migrate.js';
import { seed } from './domain/seed.js';
import { criarMeta } from './services/meta.js';
import { criarYampi } from './services/yampi.js';
import { criarPagarme } from './services/pagarme.js';
import { criarChatwoot } from './services/chatwoot.js';
import { criarOpenAI } from './services/openai.js';
import { criarAuth } from './plugins/auth.js';
import { webhookRoutes } from './routes/webhooks.js';
import { flowRoutes } from './routes/flow.js';
import { statusRoutes } from './routes/status.js';
import { adminRoutes } from './routes/admin.js';
import { startSweeper } from './sweeper.js';
import type { AgenteCtx } from './domain/agente/agente.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const cfg = loadConfig();
  const pool = getPool();
  const redis = getRedis();

  const aplicadas = await migrate(pool);
  if (aplicadas.length) console.log('[migrate]', aplicadas.join(', '));
  await seed(pool);

  const chatwootConfigurado = Boolean(cfg.CHATWOOT_URL && cfg.CHATWOOT_API_TOKEN && cfg.CHATWOOT_ACCOUNT_ID);
  const ctx: AgenteCtx = {
    db: pool,
    redis,
    cfg,
    meta: criarMeta(cfg),
    yampi: criarYampi(cfg),
    pagarme: criarPagarme(cfg),
    chatwoot: chatwootConfigurado ? criarChatwoot(cfg) : null,
    openai: cfg.OPENAI_API_KEY ? criarOpenAI(cfg) : null,
  };

  const faltando = [
    !cfg.METAWA_TOKEN && 'METAWA_TOKEN',
    !cfg.PAGARME_SECRET_KEY && 'PAGARME_SECRET_KEY',
    !cfg.YAMPI_TOKEN && 'YAMPI_TOKEN',
    !chatwootConfigurado && 'CHATWOOT_*',
    !cfg.OPENAI_API_KEY && 'OPENAI_API_KEY',
    !cfg.ADMIN_PASS_HASH && 'ADMIN_PASS_HASH',
    !cfg.FLOW_PRIVATE_KEY && 'FLOW_PRIVATE_KEY (data channel do flow v6+)',
  ].filter(Boolean);
  if (faltando.length) console.warn('[config] integrações sem credencial:', faltando.join(', '));
  if (cfg.METAWA_TOKEN && !cfg.META_APP_SECRET) {
    // Meta chamando DIRETO: sem o secret o webhook aceita payload sem assinatura
    console.warn('[SEGURANÇA] META_APP_SECRET vazio — o /webhook/meta está SEM validação de assinatura. Configurar antes do cutover.');
  }

  const app = Fastify({
    logger: {
      level: cfg.LOG_LEVEL,
      transport: cfg.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
      serializers: {
        // token de webhook (?t=) nunca vai pro log
        req(req: any) {
          return {
            method: req.method,
            url: String(req.url).replace(/([?&]t=)[^&]*/g, '$1[redacted]'),
            remoteAddress: req.ip,
          };
        },
      },
    },
    trustProxy: true, // atrás do Traefik
  });

  // Preserva o body bruto (HMAC do webhook Meta) e aceita body vazio
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      const str = (body as string) || '';
      (req as any).rawBody = str;
      const trimmed = str.trim();
      done(null, trimmed ? JSON.parse(trimmed) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  await app.register(rateLimit, { global: false });

  const auth = criarAuth(cfg, redis);

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  webhookRoutes(app, ctx);
  flowRoutes(app, ctx); // data channel do flow (v6/v7)
  statusRoutes(app, ctx, auth);
  adminRoutes(app, ctx, auth);

  // Painel buildado (produção): fallback SPA
  const publicDir = join(__dirname, '..', 'public');
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/webhook') && !req.url.startsWith('/wa-upsell')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  const pararSweeper = startSweeper(ctx);

  const shutdown = async () => {
    pararSweeper();
    await app.close().catch(() => {});
    await closeRedis();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  console.log(`agente_upsell on :${cfg.PORT}`);
}

main().catch((e) => {
  console.error('boot falhou:', e);
  process.exit(1);
});
