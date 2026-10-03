import type { Logger, TextToSpeech } from '../../application/ports/index.ts';

// OpenAI text-to-speech: POST /v1/audio/speech with response_format "pcm"
// streams raw 24 kHz 16-bit mono little-endian samples (chunked transfer).

export interface OpenAITtsConfig {
  apiKey: string;
  baseURL: string; // https://api.openai.com/v1
  model: string; // gpt-4o-mini-tts
  voice: string; // marin, cedar, coral...
  instructions: string;
}

export class OpenAITts implements TextToSpeech {
  readonly name = 'openai-tts';
  readonly sampleRate = 24000;

  constructor(
    private cfg: OpenAITtsConfig,
    private log: Logger,
  ) {}

  async *synthesize(text: string, signal?: AbortSignal, lang?: 'en' | 'fr'): AsyncIterable<Buffer> {
    const started = Date.now();
    const body: Record<string, unknown> = { model: this.cfg.model, voice: this.cfg.voice, input: text.slice(0, 3000), response_format: 'pcm' };
    if (/gpt-4o-mini-tts/.test(this.cfg.model)) {
      const lng = lang === 'fr' ? 'Speak in French, with a natural French accent.' : '';
      const instructions = [this.cfg.instructions, lng].filter(Boolean).join(' ');
      if (instructions) body.instructions = instructions;
    }
    const res = await fetch(`${this.cfg.baseURL.replace(/\/$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!res.ok || !res.body) throw new Error(`openai tts ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const reader = res.body.getReader();
    let first = true;
    let carry: Buffer | null = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (first) {
        this.log.info(`tts first chunk ${Date.now() - started}ms`);
        first = false;
      }
      let buf = Buffer.from(value);
      if (carry) {
        buf = Buffer.concat([carry, buf]);
        carry = null;
      }
      if (buf.length % 2) {
        carry = buf.subarray(buf.length - 1);
        buf = buf.subarray(0, buf.length - 1);
      }
      if (buf.length) yield buf;
    }
  }
}
