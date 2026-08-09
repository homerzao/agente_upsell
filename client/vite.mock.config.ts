// SÓ DESENVOLVIMENTO — `npm run dev:mock` (porta 5199).
// Sobe o painel com uma API falsa: dá pra mexer na UI sem Postgres/Redis/Docker.
// Os dados são fictícios; nada aqui entra no build de produção.
//
// O /api/conversas/:id/mensagens devolve UMA MENSAGEM NOVA a cada chamada —
// assim dá pra ver na tela se um botão de atualizar buscou de verdade.
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const CLIENT = dirname(fileURLToPath(import.meta.url));

const conversas = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  wa_upsell_id: i + 1,
  chatwoot_conversation_id: 500 + i,
  status: i % 3 === 0 ? 'humano' : 'bot',
  handoff_motivo: i % 3 === 0 ? 'cliente pediu humano' : null,
  order_id: 169610420 + i,
  order_number: `15172213212958${20 + i}`,
  customer_name: ['Maria da Silva', 'Jorge Andrade', 'Ana Paula Souza', 'Carlos Eduardo', 'Fernanda Lima', 'Rafael Torres'][i],
  customer_phone: `55119876543${10 + i}`,
  etapa: ['pix_enviado', 'pago', 'corrigir_sac', 'aguardando_confirmacao', 'recusado', 'confirmado'][i],
  mensagens: 3 + i,
  custo: 0.0042 * (i + 1),
  atualizado_em: new Date(Date.now() - i * 6e5).toISOString(),
}));

const base: Record<number, any[]> = {};
let contador = 0;

function mensagensDe(id: number) {
  if (!base[id]) {
    base[id] = [
      { id: 1, direcao: 'out', texto: '🏆 Ticket Dourado garantido, Maria!\n\nSeu Kit Clareador completo por R$ 49,91 entra no pedido assim que o PIX for pago.', criado_em: new Date(Date.now() - 9e5).toISOString(), tokens: null, prompt_hash: null },
      { id: 2, direcao: 'in', texto: 'oi, o pix expirou? ainda dá tempo?', criado_em: new Date(Date.now() - 6e5).toISOString(), tokens: null, prompt_hash: null },
      { id: 3, direcao: 'out', texto: 'Oi! Consigo sim gerar um novo pra você agora mesmo 💛', criado_em: new Date(Date.now() - 3e5).toISOString(), tokens: 320, prompt_hash: 'abcdef1234567890' },
    ];
  }
  // cada chamada acrescenta uma mensagem: prova se o botão realmente busca
  contador++;
  base[id] = [
    ...base[id],
    { id: 100 + contador, direcao: 'in', texto: `[mensagem nova #${contador} — chegou nesta busca]`, criado_em: new Date().toISOString(), tokens: null, prompt_hash: null },
  ];
  return base[id];
}

function mockApi(): Plugin {
  return {
    name: 'mock-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const p = url.pathname;
        if (!p.startsWith('/api')) return next();
        const json = (body: unknown) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        // eslint-disable-next-line no-console
        console.log('[mock]', req.method, p);
        const comPrevia = (c: any) => {
          const msgs = base[c.id] ?? [];
          const ult = msgs[msgs.length - 1];
          return {
            ...c,
            mensagens: msgs.length || c.mensagens,
            ultima_mensagem: ult?.texto ?? null,
            ultima_direcao: ult?.direcao ?? null,
            ultima_em: ult?.criado_em ?? c.atualizado_em,
          };
        };
        if (p === '/api/auth/me') return json({ user: 'jorge', csrf: 'csrf-teste' });
        if (p === '/api/aprovacoes') return json({ correcoes: [] });
        if (p === '/api/conversas') {
          return json({
            conversas: conversas.map(comPrevia),
            total: conversas.length,
            chatwoot_link_base: 'https://techsac.exemplo/app/accounts/1/conversations',
          });
        }
        const mMsgs = p.match(/^\/api\/conversas\/(\d+)\/mensagens$/);
        if (mMsgs) return json({ mensagens: mensagensDe(Number(mMsgs[1])) });
        const mEnvio = p.match(/^\/api\/conversas\/(\d+)\/mensagem$/);
        if (mEnvio) {
          const id = Number(mEnvio[1]);
          const c = conversas.find((x) => x.id === id);
          if (c?.status !== 'humano') {
            res.statusCode = 400;
            return json({ erro: 'assuma a conversa antes de enviar (o bot ainda está respondendo)' });
          }
          let corpo = '';
          req.on('data', (d) => (corpo += d));
          return req.on('end', () => {
            const texto = JSON.parse(corpo || '{}').texto ?? '';
            base[id] = [
              ...(base[id] ?? []),
              { id: 200 + ++contador, direcao: 'out', texto, criado_em: new Date().toISOString(), contexto: { origem: 'operador', usuario: 'jorge' } },
            ];
            json({ ok: true });
          });
        }
        const mAcao = p.match(/^\/api\/conversas\/(\d+)\/(assumir|devolver)$/);
        if (mAcao) {
          const c = conversas.find((x) => x.id === Number(mAcao[1]));
          if (c) {
            c.status = mAcao[2] === 'assumir' ? 'humano' : 'bot';
            c.handoff_motivo = mAcao[2] === 'assumir' ? 'assumida no painel' : null;
          }
          return json({ ok: true });
        }
        const mConv = p.match(/^\/api\/conversas\/(\d+)$/);
        if (mConv) {
          const c = conversas.find((x) => x.id === Number(mConv[1]));
          return c ? json({ conversa: comPrevia(c) }) : json({ erro: 'não encontrada' });
        }
        return json({});
      });
    },
  };
}

export default defineConfig({
  root: CLIENT,
  plugins: [react(), mockApi()],
  server: { port: 5199, strictPort: true },
});
