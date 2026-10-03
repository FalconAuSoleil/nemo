import type { SearchOptions, WebSearch } from '../../application/ports/index.ts';
import { normalize } from '../../domain/text.ts';
import { CORPUS } from './demo-knowledge.ts';

// Offline stand-in for Tavily. Results are clearly labelled as offline demo data.

export class OfflineWebSearch implements WebSearch {
  readonly name = 'offline';

  async search(query: string, opts: SearchOptions = {}) {
    const lang = opts.language ?? 'en';
    await new Promise((r) => setTimeout(r, 500));
    const q = new Set(normalize(query).split(' ').filter((w) => w.length > 3));
    const scored = CORPUS.map((r, i) => {
      const words = new Set(normalize(`${r.title.en} ${r.title.fr} ${r.content.en} ${r.content.fr} ${r.tags}`).split(' '));
      const tagWords = new Set(normalize(r.tags).split(' '));
      // Unique matches, with tags weighing a bit more.
      let s = 0;
      for (const w of q) if (words.has(w)) s += tagWords.has(w) ? 1.5 : 1;
      return { r, s: s - i / 100 };
    })
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
      .map(({ r }) => ({ title: r.title[lang], url: r.url, content: `${r.content[lang]} (offline demo data)` }));
    return { results: scored };
  }

  async extract(urls: string[]) {
    return urls.map((url) => ({ url, content: CORPUS.find((c) => c.url === url)?.content.en ?? '' }));
  }
}
