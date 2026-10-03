import PQueue from 'p-queue';
import type { Logger, SearchOptions, SearchResult, WebSearch } from '../../application/ports/index.ts';

// Tavily real-time web search. Rate-limited client side (dev keys: 100 RPM).

export class TavilyWebSearch implements WebSearch {
  readonly name = 'tavily';
  private queue = new PQueue({ concurrency: 6, intervalCap: 80, interval: 60_000 });

  constructor(
    private apiKey: string,
    private log: Logger,
    private baseURL = 'https://api.tavily.com',
  ) {}

  async search(query: string, opts: SearchOptions = {}, signal?: AbortSignal) {
    const body: Record<string, unknown> = {
      query: query.slice(0, 400),
      search_depth: opts.depth ?? 'basic',
      max_results: opts.maxResults ?? 5,
      topic: opts.topic ?? 'general',
      include_answer: opts.includeAnswer ?? false,
    };
    if (opts.depth !== 'ultra-fast') body.chunks_per_source = 2;
    if (opts.timeRange) body.time_range = opts.timeRange;
    const data = await this.post<{ answer?: string; results?: any[] }>('/search', body, signal);
    const results: SearchResult[] = (data.results ?? []).map((r) => ({
      title: String(r.title ?? r.url),
      url: String(r.url),
      content: String(r.content ?? ''),
      score: r.score,
      publishedDate: r.published_date,
    }));
    this.log.info(`tavily search "${query.slice(0, 60)}" -> ${results.length}`);
    return { answer: data.answer, results };
  }

  async extract(urls: string[], query?: string, signal?: AbortSignal) {
    const data = await this.post<{ results?: any[] }>('/extract', { urls: urls.slice(0, 5), query, format: 'markdown', chunks_per_source: query ? 3 : undefined }, signal);
    return (data.results ?? []).map((r) => ({ url: String(r.url), content: String(r.raw_content ?? '').slice(0, 6000) }));
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.queue.add(
      async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const res = await fetch(`${this.baseURL}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
          });
          if (res.status === 429) {
            const wait = Number(res.headers.get('retry-after') ?? 2) * 1000;
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          if (!res.ok) throw new Error(`tavily ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
          return (await res.json()) as T;
        }
        throw new Error(`tavily ${path} rate limited`);
      },
      { throwOnTimeout: true },
    ) as Promise<T>;
  }
}
