import PQueue from 'p-queue';
import type { Logger, SearchOptions, SearchResult, WebSearch } from '../../application/ports/index.ts';

// Web search through OpenAI's hosted `web_search` tool (Responses API).
// The model searches, reads, and answers with url_citation annotations; each
// cited passage becomes one SearchResult.

export interface OpenAISearchConfig {
  apiKey: string;
  baseURL: string; // https://api.openai.com/v1
  model: string; // gpt-6-luna
  reasoningEffort: string; // low keeps it around 5 s
}

interface Annotation {
  type: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

const cleanUrl = (u: string) => u.replace(/[?&]utm_source=openai$/, '').replace(/\?$/, '');
const cleanText = (s: string) =>
  s
    .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, '') // ([domain](url)) citation chips
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/^\s*[-•]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Turns a Responses API output into one result per cited source. */
export function resultsFromResponse(output: any[]): { answer: string; results: SearchResult[] } {
  const results: SearchResult[] = [];
  let answer = '';
  for (const item of output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) {
      const text: string = c.text ?? '';
      answer += text;
      for (const a of (c.annotations ?? []) as Annotation[]) {
        if (a.type !== 'url_citation' || !a.url) continue;
        const url = cleanUrl(a.url);
        if (results.some((r) => r.url === url)) continue;
        // The passage is the line (bullet) that contains the citation.
        const start = text.lastIndexOf('\n', a.start_index ?? 0) + 1;
        const endNl = text.indexOf('\n', a.end_index ?? 0);
        const passage = cleanText(text.slice(start, endNl < 0 ? undefined : endNl));
        results.push({ title: a.title || url, url, content: passage || cleanText(text).slice(0, 400) });
      }
    }
  }
  return { answer: cleanText(answer).slice(0, 600), results };
}

export class OpenAIWebSearch implements WebSearch {
  readonly name = 'openai-search';
  // Each hosted search reads pages (~10-30k tokens): stay under the org's TPM.
  private queue = new PQueue({ concurrency: 2, intervalCap: 8, interval: 60_000 });

  constructor(
    private cfg: OpenAISearchConfig,
    private log: Logger,
  ) {}

  async search(query: string, opts: SearchOptions = {}, signal?: AbortSignal) {
    return this.queue.add(
      async () => {
        const started = Date.now();
        const n = Math.min(opts.maxResults ?? 5, 6);
        let res: Response;
        for (let attempt = 0; ; attempt++) {
        res = await fetch(`${this.cfg.baseURL.replace(/\/$/, '')}/responses`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({
            model: this.cfg.model,
            tools: [{ type: 'web_search' }],
            tool_choice: 'required',
            reasoning: { effort: this.cfg.reasoningEffort },
            input: `Search the web for: ${query.slice(0, 400)}\nReturn up to ${n} short findings as bullet points, one source cited per bullet, with concrete numbers or names. Keep the language of the query.`,
          }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000),
        });
          if (res.status !== 429 || attempt >= 2) break;
          // Rate limited: wait what the API asks (or a few seconds), then retry.
          const body = await res.text();
          const wait = Number(res.headers.get('retry-after')) * 1000 || Number(/try again in ([\d.]+)s/.exec(body)?.[1] ?? 5) * 1000;
          this.log.warn(`openai search rate limited, retrying in ${Math.round(wait)}ms`);
          await new Promise((r) => setTimeout(r, Math.min(wait + 250, 30_000)));
        }
        if (!res.ok) throw new Error(`openai web search ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const json = (await res.json()) as { output?: any[] };
        const out = resultsFromResponse(json.output ?? []);
        this.log.info(`openai search "${query.slice(0, 60)}" -> ${out.results.length} (${Date.now() - started}ms)`);
        return { answer: out.answer, results: out.results.slice(0, n) };
      },
      { throwOnTimeout: true },
    ) as Promise<{ answer?: string; results: SearchResult[] }>;
  }

  async extract(urls: string[], _query?: string, signal?: AbortSignal) {
    const pages = await Promise.all(
      urls.slice(0, 3).map(async (url) => {
        try {
          const r = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
          const html = await r.text();
          const text = html
            .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          return { url, content: text.slice(0, 6000) };
        } catch {
          return { url, content: '' };
        }
      }),
    );
    return pages.filter((p) => p.content);
  }
}
