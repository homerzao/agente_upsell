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
  OPENAI_PRECO_INPUT_1M: z.coerce.number().default(0),
  OPENAI_PRECO_OUTPUT_1M: z.coerce.number().default(0),

  WA_FONE_TESTE: z.string().default('5591992148793'),
  // Página de acompanhamento do pedido: base + NÚMERO do pedido Yampi.
  // Funciona desde o pagamento; o código de rastreio aparece lá quando despacha.
  RASTREIO_URL_BASE: z.string().default('https://rastreio.hidrabene.com.br/status/'),
  WA_UPSELL_TEMPLATE_CONFIRMA: z.string().default('confirma_pedido_up'),
  // v6 (data_exchange): o "Confirmar Pedido" chama o data channel /flow/upsell
  WA_UPSELL_FLOW_ID: z.string().default('3548925675262517'),
  WA_UPSELL_HEADER_MEDIA_ID: z.string().default(''),
  WA_UPSELL_HEADER_URL: z.string().default(''),
  WA_UPSELL_PIX_TTL_MIN: z.coerce.number().default(5),
  WA_UPSELL_CLOSE_MIN: z.coerce.number().default(10),
  // Janela pré-aceite: fecha aguardando_confirmacao/confirmado/erro_disparo (ERP libera ~28min)
  WA_UPSELL_JANELA_MIN: z.coerce.number().default(25),
  // Auto-close SÓ do corrigir_sac (atendimento humano)
  WA_UPSELL_AUTO_CLOSE_HORAS: z.coerce.number().default(4),
  // Conversa de funil FECHADO sem interação há X min: destrava no TechSAC e
  // devolve pro fluxo normal do SAC (pedido do Jorge, 08/08)
  WA_UPSELL_LIBERA_CONVERSA_MIN: z.coerce.number().default(60),
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
