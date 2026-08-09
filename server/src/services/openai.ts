// OpenAI — motor do agente (chat completions com tools).

export type OpenAIService = ReturnType<typeof criarOpenAI>;

type FetchFn = typeof fetch;

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export function criarOpenAI(
  cfg: {
    OPENAI_API_KEY: string;
    OPENAI_MODEL: string;
    OPENAI_MODELO_AUDIO?: string;
    OPENAI_MODELO_VISAO?: string;
    OPENAI_PRECO_INPUT_1M: number;
    OPENAI_PRECO_OUTPUT_1M: number;
  },
  fetchFn: FetchFn = fetch,
) {
  // Cliente manda áudio e imagem o tempo todo no WhatsApp. Sem isso o agente
  // não fazia ideia do que chegou (pedido do Jorge, 09/08).
  async function transcrever(audio: ArrayBuffer, mime = 'audio/ogg'): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), 'audio.ogg');
    form.append('model', cfg.OPENAI_MODELO_AUDIO || 'whisper-1');
    form.append('language', 'pt');
    const r = await fetchFn('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.OPENAI_API_KEY}` },
      body: form,
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`whisper ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return String(j.text ?? '').trim();
  }

  async function descreverImagem(imagem: ArrayBuffer, mime = 'image/jpeg', legenda = ''): Promise<string> {
    const b64 = Buffer.from(imagem).toString('base64');
    const r = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: cfg.OPENAI_MODELO_VISAO || cfg.OPENAI_MODEL,
        reasoning_effort: 'none',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Descreva em 1-2 frases o que esta imagem mostra, no contexto de atendimento de e-commerce (ex.: comprovante de PIX, print de erro, foto de produto, print de conversa, documento). Se houver texto relevante (valor, código, data, nome), transcreva.${legenda ? ` Legenda do cliente: "${legenda}"` : ''}`,
              },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            ],
          },
        ],
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`visao ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return String(j.choices?.[0]?.message?.content ?? '').trim();
  }
  async function chat(messages: ChatMessage[], tools?: ToolDef[]): Promise<{ message: ChatMessage; usage: Usage }> {
    const r = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: cfg.OPENAI_MODEL,
        messages,
        // gpt-5.6-luna: tools + reasoning no chat/completions exigem effort 'none'
        // (400 sem isso). Conversa de atendimento não precisa de reasoning pesado.
        ...(tools?.length ? { tools, tool_choice: 'auto', reasoning_effort: 'none' } : {}),
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`openai ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return {
      message: j.choices?.[0]?.message ?? { role: 'assistant', content: null },
      usage: j.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  // Custo em R$/US$ conforme os preços configurados (0 = não calcular).
  const custo = (u: Usage): number =>
    (u.prompt_tokens / 1e6) * cfg.OPENAI_PRECO_INPUT_1M +
    (u.completion_tokens / 1e6) * cfg.OPENAI_PRECO_OUTPUT_1M;

  return { chat, custo, transcrever, descreverImagem };
}
