import OpenAI from 'openai';
import type { ChatRequest, ChatResponse, LanguageModel, Logger, ModelTier, ToolCall } from '../../application/ports/index.ts';

// Chat Completions adapter for two providers:
// - "nemotron": NVIDIA Nemotron on Nebius Token Factory (OpenAI-compatible API)
// - "openai":   OpenAI models through the official API
// Both speak the same wire format; they differ on a few parameters.

export type Dialect = 'nemotron' | 'openai';

export interface ChatModelConfig {
  apiKey: string;
  baseURL: string;
  models: Record<ModelTier, string>;
  dialect: Dialect;
  /** OpenAI reasoning models: effort per tier (e.g. fast: "minimal", smart: "low"). */
  reasoningEffort?: Partial<Record<ModelTier, string>>;
}

/** Back-compat config shape for Nemotron. */
export type NemotronConfig = Omit<ChatModelConfig, 'dialect'>;

const OPTIONAL_PARAMS = ['chat_template_kwargs', 'temperature', 'top_p', 'reasoning_effort', 'parallel_tool_calls'] as const;

export class ChatCompletionsLanguageModel implements LanguageModel {
  readonly name: 'nemotron' | 'openai';
  private client: OpenAI;
  // Parameters an endpoint rejected once (HTTP 400), remembered per model.
  private rejected = new Map<string, Set<string>>();
  private noNamedToolChoice = false;

  constructor(
    private cfg: ChatModelConfig,
    private log: Logger,
  ) {
    this.name = cfg.dialect;
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 3, timeout: 45_000 });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = this.cfg.models[req.tier];
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) {
      if (m.role === 'tool') messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      else if (m.role === 'assistant')
        messages.push({
          role: 'assistant',
          content: m.content || '',
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
            : {}),
        });
      else messages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = { model, messages };
    const maxTokens = req.maxTokens ?? 800;
    if (this.cfg.dialect === 'nemotron') {
      body.temperature = req.temperature ?? 0.4;
      body.top_p = 0.95;
      body.max_tokens = maxTokens;
      // Nemotron chat templates read this flag; thinking stays off on the realtime path.
      body.chat_template_kwargs = { enable_thinking: !!req.reasoning };
    } else {
      const effort = this.cfg.reasoningEffort?.[req.tier];
      // Reasoning models spend hidden tokens before answering: leave them room.
      body.max_completion_tokens = effort && effort !== 'none' ? maxTokens + 2000 : maxTokens;
      if (effort) body.reasoning_effort = effort;
      else body.temperature = req.temperature ?? 0.4;
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice =
        typeof req.toolChoice === 'object'
          ? this.noNamedToolChoice
            ? 'required'
            : { type: 'function', function: { name: req.toolChoice.name } }
          : (req.toolChoice ?? 'auto');
    }
    for (const p of this.rejected.get(model) ?? []) delete body[p];

    const started = Date.now();
    const res = await this.create(body, req.signal);
    const msg = res.choices[0]?.message;
    const toolCalls: ToolCall[] = [];
    for (const tc of msg?.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      toolCalls.push({ id: tc.id, name: tc.function.name, args: parseArgs(tc.function.arguments) });
    }
    // Some deployments return the tool call inline as text (<tool_call>...). Recover it.
    if (!toolCalls.length && msg?.content && req.tools?.length) toolCalls.push(...recoverInlineToolCalls(msg.content));
    this.log.info(`llm ${req.tier} ${model} ${Date.now() - started}ms tools=${toolCalls.map((t) => t.name).join(',') || '-'}`);
    return { content: stripThinking(msg?.content ?? ''), toolCalls };
  }

  /** Lists the models the key can use and warns about misconfigured ids. */
  async probe(): Promise<boolean> {
    try {
      const list = await this.client.models.list();
      const ids = list.data.map((m) => m.id);
      if (this.cfg.dialect === 'openai') {
        this.log.info(`OpenAI: ${ids.length} models available`);
        for (const tier of ['fast', 'smart'] as const) if (!ids.includes(this.cfg.models[tier])) this.log.warn(`model "${this.cfg.models[tier]}" not listed for this key`);
        return true;
      }
      const nvidia = ids.filter((id) => /nvidia|nemotron/i.test(id));
      this.log.info(`Token Factory: ${ids.length} models, NVIDIA: ${nvidia.join(', ') || 'none'}`);
      for (const tier of ['fast', 'smart'] as const) {
        const wanted = this.cfg.models[tier];
        if (ids.includes(wanted)) continue;
        const hint = tier === 'fast' ? /lightning|nano/i : /super|ultra/i;
        const fallback = nvidia.find((id) => hint.test(id));
        this.log.warn(`model "${wanted}" not listed${fallback ? `, using "${fallback}"` : ''}`);
        if (fallback) this.cfg.models[tier] = fallback;
      }
      return true;
    } catch (err) {
      this.log.error(`cannot list ${this.cfg.dialect} models (check the API key / base URL)`, String(err));
      return false;
    }
  }

  private async create(body: Record<string, unknown>, signal?: AbortSignal): Promise<OpenAI.Chat.ChatCompletion> {
    const model = String(body.model);
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.client.chat.completions.create(body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, {
          signal,
        })) as OpenAI.Chat.ChatCompletion;
      } catch (err) {
        const status = (err as { status?: number }).status;
        const text = String((err as Error).message ?? err);
        if (status !== 400 || attempt >= 4) throw err;
        // Drop the optional parameter the endpoint complains about, and remember it.
        const bad = OPTIONAL_PARAMS.find((p) => p in body && text.includes(p));
        if (bad || (body.chat_template_kwargs && /extra|unrecognized|unknown/i.test(text))) {
          const param = bad ?? 'chat_template_kwargs';
          this.log.warn(`${model} rejected "${param}"; not sending it anymore`, text);
          this.rejected.set(model, new Set([...(this.rejected.get(model) ?? []), param]));
          delete body[param];
        } else if ('max_completion_tokens' in body && text.includes('max_completion_tokens')) {
          body.max_tokens = body.max_completion_tokens;
          delete body.max_completion_tokens;
        } else if ('max_tokens' in body && text.includes('max_tokens')) {
          body.max_completion_tokens = body.max_tokens;
          delete body.max_tokens;
        } else if (body.tool_choice && typeof body.tool_choice === 'object') {
          this.log.warn('endpoint rejected a named tool_choice; using "required"', text);
          this.noNamedToolChoice = true;
          body.tool_choice = 'required';
        } else if (body.tool_choice === 'required') {
          body.tool_choice = 'auto';
        } else throw err;
      }
    }
  }
}

/** NVIDIA Nemotron on Nebius Token Factory. */
export class NemotronLanguageModel extends ChatCompletionsLanguageModel {
  constructor(cfg: NemotronConfig, log: Logger) {
    super({ ...cfg, dialect: 'nemotron' }, log);
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Parses the Qwen3-coder style `<tool_call><function=name><parameter=p>v</parameter></function></tool_call>`. */
export function recoverInlineToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const fnRe = /<function=([\w.-]+)>([\s\S]*?)<\/function>/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = fnRe.exec(text))) {
    const args: Record<string, unknown> = {};
    const pRe = /<parameter=([\w.-]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
    let p: RegExpExecArray | null;
    while ((p = pRe.exec(m[2]))) {
      const raw = p[2];
      try {
        args[p[1]] = JSON.parse(raw);
      } catch {
        args[p[1]] = raw;
      }
    }
    calls.push({ id: `inline-${i++}`, name: m[1], args });
  }
  return calls;
}
