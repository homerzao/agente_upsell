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
    OPENAI_PRECO_INPUT_1M: number;
    OPENAI_PRECO_OUTPUT_1M: number;
  },
  fetchFn: FetchFn = fetch,
) {
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

  return { chat, custo };
}
