import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

// Envs do sistema (valores com o Jorge; ver .env.example).
// Integrações opcionais no boot: o sistema sobe sem elas e loga o que falta —
// mas BACKEND_TOKEN, SESSION_SECRET e DATABASE_URL são obrigatórios.
const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
  APP_DOMAIN: z.string().default(''),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  BACKEND_TOKEN: z.string().min(16),
  STATUS_TOKEN: z.string().default(''),
  SESSION_SECRET: z.string().min(16),

  ADMIN_USER: z.string().default('admin'),
  ADMIN_PASS_HASH: z.string().default(''),

  METAWA_TOKEN: z.string().default(''),
  METAWA_PHONE_ID: z.string().default(''),
  METAWA_WABA_ID: z.string().default(''),
  METAWA_VERIFY_TOKEN: z.string().default(''),
  META_APP_SECRET: z.string().default(''),

  CHATWOOT_URL: z.string().default(''),
  CHATWOOT_ACCOUNT_ID: z.string().default(''),
  CHATWOOT_API_TOKEN: z.string().default(''),
  CHATWOOT_INBOX_ID: z.string().default(''),
  CHATWOOT_AGENT_ID: z.string().default(''),
  CHATWOOT_TEAM_ID: z.string().default(''),

  YAMPI_ALIAS: z.string().default(''),
  YAMPI_TOKEN: z.string().default(''),
  YAMPI_SECRET: z.string().default(''),

  PAGARME_SECRET_KEY: z.string().default(''),

  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-5.6-luna'),
  // Áudio do cliente (Whisper) e imagem (visão) viram texto pro agente
  OPENAI_MODELO_AUDIO: z.string().default('whisper-1'),
  OPENAI_MODELO_VISAO: z.string().default('gpt-5.6-luna'),
  OPENAI_PRECO_INPUT_1M: z.coerce.number().default(0),
  OPENAI_PRECO_OUTPUT_1M: z.coerce.number().default(0),

  WA_FONE_TESTE: z.string().default('5591992148793'),
  // Página de acompanhamento do pedido: base + NÚMERO do pedido Yampi.
  // Funciona desde o pagamento; o código de rastreio aparece lá quando despacha.
  RASTREIO_URL_BASE: z.string().default('https://rastreio.hidrabene.com.br/status/'),
  // '1' = dispara o template pela rota do TechSAC (cria a conversa travada e
  // devolve o conversation_id INTERNO, necessário pra destravar depois).
  // '0' = envia direto pela Meta (sem id interno; destravar fica indisponível).
  DISPARO_VIA_TECHSAC: z.string().default('1'),
  WA_UPSELL_TEMPLATE_CONFIRMA: z.string().default('confirma_pedido_up'),
  // v6 (data_exchange): o "Confirmar Pedido" chama o data channel /flow/upsell
  WA_UPSELL_FLOW_ID: z.string().default('3548925675262517'),
  WA_UPSELL_HEADER_MEDIA_ID: z.string().default(''),
  WA_UPSELL_HEADER_URL: z.string().default(''),
  // Validade REAL do PIX na Pagar.me = o que o cliente vê + a MARGEM abaixo.
  // O cliente nunca vê este número: ele é a gordura (Jorge, 10/08: "mostraria
  // prazo real -3 min, assim tem gordura") pra quem paga no último segundo.
  WA_UPSELL_PIX_TTL_MIN: z.coerce.number().default(23),
  // Gordura invisível: o relógio da página e a conta do lembrete param aqui
  // antes do vencimento real. Quem paga com o timer zerando ainda entra.
  WA_UPSELL_PIX_MARGEM_MIN: z.coerce.number().default(3),
  // Prazo ANUNCIADO no aceite. Tem que ser TTL − MARGEM pra bater com o
  // relógio da página (Jorge, 10/08: "não faz sentido ser 20m se falamos na
  // msg que é 10min") — o cliente vê o MESMO número em todo lugar.
  WA_UPSELL_PIX_PRAZO_ANUNCIADO_MIN: z.coerce.number().default(20),
  // Fecha como expirado só DEPOIS da validade real (com folga de 1 min)
  WA_UPSELL_CLOSE_MIN: z.coerce.number().default(24),
  // Base pública dos links gerados (página do PIX: {PUBLIC_URL}/pix/{token}).
  // O default é o domínio ATUAL da marca de propósito: se a variável sumir do
  // .env, o pior caso é continuar no domínio certo — antes o default era o
  // domínio antigo e a regressão seria silenciosa (achado da auditoria, 10/08).
  PUBLIC_URL: z.string().default('https://ticket.hidrabene.com.br'),
  // Janela pré-aceite: fecha aguardando_confirmacao/confirmado/erro_disparo (ERP libera ~28min)
  WA_UPSELL_JANELA_MIN: z.coerce.number().default(25),
  // Auto-close SÓ do corrigir_sac (atendimento humano)
  WA_UPSELL_AUTO_CLOSE_HORAS: z.coerce.number().default(4),
  // Conversa de funil FECHADO sem interação há X min: destrava no TechSAC e
  // devolve pro fluxo normal do SAC (pedido do Jorge, 08/08)
  WA_UPSELL_LIBERA_CONVERSA_MIN: z.coerce.number().default(60),
  // Idade máxima do pedido (horas) pra entrar no funil. Protege contra pedido
  // antigo sendo faturado agora parecer "acabou de pagar" (ver decidirDisparo).
  WA_UPSELL_IDADE_MAX_HORAS: z.coerce.number().default(24),
  // UMA oferta por CLIENTE nesta janela: dois pedidos do mesmo fone não geram
  // duas ofertas (com multi-oferta seria pior — Kit num pedido, FPS 90 no outro).
  WA_UPSELL_JANELA_CLIENTE_HORAS: z.coerce.number().default(24),
  // Espera X segundos sem mensagem nova antes de responder, pra juntar as
  // mensagens picadas do cliente numa resposta só (0 = responde na hora).
  WA_UPSELL_DEBOUNCE_SEG: z.coerce.number().default(20),
  // Lembrete X minutos APÓS o envio do PIX (0 = desligado). Calibrar pelo prazo
  // ANUNCIADO: com 10 anunciado, 7 aqui = "vence em 3 minutos".
  WA_UPSELL_LEMBRETE_PIX_APOS_MIN: z.coerce.number().default(7),
  // '1' = loga resumo (campo/tipos/remetentes) de TODO webhook da Meta que
  // chega — diagnóstico de distribuição entre apps da WABA. Desligar depois.
  WAUP_DEBUG_META: z.string().default('0'),
  // Chave privada RSA do NÚMERO (whatsapp_business_encryption) — a MESMA do
  // agente_ecom; NUNCA gerar par novo (quebraria o endpoint em produção).
  FLOW_PRIVATE_KEY: z.string().default(''),
});

export type Config = z.infer<typeof schema> & {
  webhookTokenYampi: string;
  webhookTokenPagarme: string;
  webhookTokenChatwoot: string;
  webhookTokenMeta: string;
};

// Token fraco de URL de webhook: derivado por sha256 do BACKEND_TOKEN (um por origem).
export function derivarTokenWebhook(backendToken: string, origem: string): string {
  return crypto.createHash('sha256').update(`${backendToken}:webhook-${origem}`).digest('hex').slice(0, 32);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  return {
    ...parsed,
    webhookTokenYampi: derivarTokenWebhook(parsed.BACKEND_TOKEN, 'yampi'),
    webhookTokenPagarme: derivarTokenWebhook(parsed.BACKEND_TOKEN, 'pagarme'),
    webhookTokenChatwoot: derivarTokenWebhook(parsed.BACKEND_TOKEN, 'chatwoot'),
    webhookTokenMeta: derivarTokenWebhook(parsed.BACKEND_TOKEN, 'meta'),
  };
}
