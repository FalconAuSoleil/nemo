import WebSocket from 'ws';
import type { Logger, SpeechStream, SpeechToText, TranscriptHandlers } from '../../application/ports/index.ts';

// OpenAI Realtime API in transcription mode (gpt-live-transcribe).
// Docs: developers.openai.com/api/docs/guides/realtime-transcription
// - audio must be PCM16 mono at 24 kHz: we upsample the 16 kHz room mic
// - gpt-live-transcribe has no server VAD: we commit on local pauses

export interface OpenAIAsrConfig {
  apiKey: string;
  baseURL: string; // wss://api.openai.com/v1
  model: string; // gpt-live-transcribe
  language: string; // ISO-639-1, e.g. "en"
  keywords: string[];
  noiseReduction: 'near_field' | 'far_field';
}

const SILENCE_RMS = 0.012; // ~ -38 dBFS
const COMMIT_AFTER_SILENCE_MS = 650;
const MAX_UTTERANCE_MS = 12_000;

/** Linear 16 kHz -> 24 kHz upsampling of PCM16LE mono. */
export function upsample16to24(pcm: Buffer): Buffer {
  const n = Math.floor(pcm.length / 2);
  const outLen = Math.floor((n * 3) / 2);
  const out = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    const pos = (i * 2) / 3;
    const a = Math.floor(pos);
    const b = Math.min(n - 1, a + 1);
    const t = pos - a;
    const v = pcm.readInt16LE(a * 2) * (1 - t) + pcm.readInt16LE(b * 2) * t;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export class OpenAIRealtimeAsr implements SpeechToText {
  readonly name = 'openai-asr';

  constructor(
    private cfg: OpenAIAsrConfig,
    private log: Logger,
  ) {}

  async open(h: TranscriptHandlers, opts: { lang?: 'en' | 'fr' } = {}): Promise<SpeechStream> {
    const language = opts.lang ?? this.cfg.language;
    const url = `${this.cfg.baseURL.replace(/^http/, 'ws').replace(/\/$/, '')}/realtime?intent=transcription`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.cfg.apiKey}` } });
    let ready = false;
    let closed = false;
    const backlog: Buffer[] = [];
    const partials = new Map<string, string>();
    // Local endpointing state
    let speaking = false;
    let speechMs = 0;
    let silenceMs = 0;
    let uncommitted = false;

    const send = (ev: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(ev));
    const commit = () => {
      if (!uncommitted) return;
      send({ type: 'input_audio_buffer.commit' });
      uncommitted = false;
      speechMs = 0;
    };
    const push = (pcm16k: Buffer) => {
      const ms = (pcm16k.length / 2 / 16000) * 1000;
      const loud = rms(pcm16k) > SILENCE_RMS;
      if (loud) {
        speaking = true;
        silenceMs = 0;
        speechMs += ms;
      } else if (speaking) silenceMs += ms;
      // Only stream audio around speech, to save tokens.
      if (speaking) {
        send({ type: 'input_audio_buffer.append', audio: upsample16to24(pcm16k).toString('base64') });
        uncommitted = true;
      }
      if (speaking && (silenceMs >= COMMIT_AFTER_SILENCE_MS || speechMs >= MAX_UTTERANCE_MS)) {
        commit();
        if (silenceMs >= COMMIT_AFTER_SILENCE_MS) speaking = false;
      }
    };

    ws.on('open', () => {
      send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              noise_reduction: { type: this.cfg.noiseReduction },
              transcription: {
                model: this.cfg.model,
                // gpt-live-transcribe takes `languages`; older models take `language`.
                ...(/live/.test(this.cfg.model) ? { languages: [language], keywords: this.cfg.keywords, delay: 'low', prompt: language === 'fr' ? 'Réunion de brainstorming en français. L’assistant s’appelle Nemo.' : 'Brainstorming meeting in English. The assistant is called Nemo.' } : { language }),
              },
              turn_detection: null,
            },
          },
        },
      });
    });

    ws.on('message', (data) => {
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (ev.type) {
        case 'session.created':
        case 'session.updated':
        case 'transcription_session.updated':
          if (!ready) {
            ready = true;
            this.log.info(`OpenAI ASR session ready (${this.cfg.model})`);
            for (const b of backlog.splice(0)) push(b);
          }
          break;
        case 'conversation.item.input_audio_transcription.delta': {
          const id = String(ev.item_id ?? 'x');
          const text = (partials.get(id) ?? '') + String(ev.delta ?? '');
          partials.set(id, text);
          if (text.trim()) h.onPartial(text.trim());
          break;
        }
        case 'conversation.item.input_audio_transcription.completed': {
          partials.delete(String(ev.item_id ?? 'x'));
          const text = String(ev.transcript ?? '').trim();
          if (text) h.onFinal(text);
          break;
        }
        case 'error':
          this.log.warn('OpenAI ASR error event', ev.error ?? ev);
          if (/api_key|auth|permission|model_not_found|invalid_model/.test(String(ev.error?.code ?? ''))) h.onError(new Error(`OpenAI realtime: ${ev.error?.message ?? ev.error?.code}`));
          break;
      }
    });
    ws.on('unexpected-response', (_req, res) => h.onError(new Error(`OpenAI realtime handshake failed: HTTP ${res.statusCode}`)));
    ws.on('error', (err) => h.onError(err as Error));
    let closedByUs = false;
    ws.on('close', (code, reason) => {
      closed = true;
      if (!closedByUs && code !== 1000) h.onError(new Error(`OpenAI realtime closed (${code} ${reason.toString()})`));
    });

    return {
      write: (pcm) => {
        if (closed) return;
        if (!ready) {
          if (backlog.length < 50) backlog.push(pcm);
          return;
        }
        push(pcm);
      },
      close: () => {
        closedByUs = true;
        try {
          commit();
          ws.close(1000);
        } catch {
          /* ignore */
        }
      },
    };
  }
}
