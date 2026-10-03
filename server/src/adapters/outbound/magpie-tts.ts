import type { Logger, TextToSpeech } from '../../application/ports/index.ts';

// NVIDIA NIM "magpie-tts-multilingual": POST /v1/audio/synthesize_online streams
// raw PCM s16le mono (chunked transfer), which we forward as-is to the host.

export interface MagpieConfig {
  baseURL: string; // http://host:9001
  voice: string; // e.g. Magpie-Multilingual.EN-US.Aria
  language: string; // en-US
  voiceFr?: string; // e.g. Magpie-Multilingual.FR-FR.Louise
  sampleRate: number; // 22050 native
}

export class MagpieTts implements TextToSpeech {
  readonly name = 'magpie-tts';
  readonly sampleRate: number;

  constructor(
    private cfg: MagpieConfig,
    private log: Logger,
  ) {
    this.sampleRate = cfg.sampleRate;
  }

  async *synthesize(text: string, signal?: AbortSignal, lang?: 'en' | 'fr'): AsyncIterable<Buffer> {
    const fr = lang === 'fr';
    const form = new FormData();
    form.set('text', text.slice(0, 1800));
    form.set('language', fr ? 'fr-FR' : this.cfg.language);
    form.set('voice', fr ? (this.cfg.voiceFr ?? 'Magpie-Multilingual.FR-FR.Louise') : this.cfg.voice);
    form.set('sample_rate_hz', String(this.cfg.sampleRate));
    form.set('encoding', 'LINEAR_PCM');
    const started = Date.now();
    const res = await fetch(`${this.cfg.baseURL}/v1/audio/synthesize_online`, {
      method: 'POST',
      body: form,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!res.ok || !res.body) throw new Error(`magpie ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
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
      // Keep frames aligned on 16-bit samples.
      if (buf.length % 2) {
        carry = buf.subarray(buf.length - 1);
        buf = buf.subarray(0, buf.length - 1);
      }
      if (buf.length) yield buf;
    }
  }
}
