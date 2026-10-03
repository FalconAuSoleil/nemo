import WebSocket from 'ws';
import type { Logger, SpeechStream, SpeechToText, TranscriptHandlers } from '../../application/ports/index.ts';

// NVIDIA NIM "nemotron-asr-streaming" through its Realtime WebSocket API.
// Docs: docs.nvidia.com/nim/speech/latest/reference/api-references/asr/realtime-asr.html

export interface NimAsrConfig {
  baseURL: string; // http://host:9000
  language: string; // en-US
  boostPhrases: string[];
  boost: number; // RNNT range 0.5 - 2.0
}

export class NimRealtimeAsr implements SpeechToText {
  readonly name = 'nim-asr';

  constructor(
    private cfg: NimAsrConfig,
    private log: Logger,
  ) {}

  async open(h: TranscriptHandlers, opts: { lang?: 'en' | 'fr' } = {}): Promise<SpeechStream> {
    const language = opts.lang === 'fr' ? 'fr-FR' : opts.lang === 'en' ? 'en-US' : this.cfg.language;
    let session: Record<string, any> = {};
    let secret: string | undefined;
    try {
      const res = await fetch(`${this.cfg.baseURL}/v1/realtime/transcription_sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = (await res.json()) as Record<string, any>;
        secret = json.client_secret?.value ?? undefined;
        session = json;
      }
    } catch (err) {
      this.log.warn('ASR session bootstrap failed, using defaults', String(err));
    }
    delete session.client_secret;
    delete session.id;
    delete session.object;

    const wsURL = `${this.cfg.baseURL.replace(/^http/, 'ws')}/v1/realtime?intent=transcription`;
    const ws = new WebSocket(wsURL, secret ? ['realtime', `realtime-token.${secret}`] : undefined);
    let ready = false;
    let closed = false;
    const backlog: Buffer[] = [];
    let partial = '';

    const sendAudio = (pcm: Buffer) => {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }));
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    };

    ws.on('open', () => {
      const update = {
        type: 'transcription_session.update',
        session: {
          ...session,
          modalities: ['text'],
          input_audio_format: 'pcm16',
          input_audio_transcription: { ...(session.input_audio_transcription ?? {}), language },
          input_audio_params: { sample_rate_hz: 16000, num_channels: 1 },
          recognition_config: {
            ...(session.recognition_config ?? {}),
            max_alternatives: 1,
            enable_automatic_punctuation: true,
            custom_configuration: 'apply_partial_pnc:true',
          },
          word_boosting: {
            enable_word_boosting: this.cfg.boostPhrases.length > 0,
            word_boosting_list: this.cfg.boostPhrases.length ? [{ phrases: this.cfg.boostPhrases, boost: this.cfg.boost }] : [],
          },
        },
      };
      ws.send(JSON.stringify(update));
    });

    ws.on('message', (data) => {
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (ev.type) {
        case 'transcription_session.updated':
          ready = true;
          for (const b of backlog.splice(0)) sendAudio(b);
          this.log.info('ASR session ready');
          break;
        case 'conversation.item.input_audio_transcription.delta':
          partial = String(ev.delta ?? '');
          if (partial.trim()) h.onPartial(partial);
          break;
        case 'conversation.item.input_audio_transcription.completed': {
          const text = String(ev.transcript ?? '').trim();
          partial = '';
          if (text) h.onFinal(text);
          break;
        }
        case 'error':
        case 'conversation.item.input_audio_transcription.failed':
          this.log.warn('ASR error event', ev.error ?? ev);
          break;
      }
    });
    ws.on('error', (err) => h.onError(err as Error));
    ws.on('close', () => {
      closed = true;
    });

    // Keep the session alive across the 60 s idle timeout with silence.
    const keepAlive = setInterval(() => {
      if (ready && ws.readyState === WebSocket.OPEN) sendAudio(Buffer.alloc(3200));
    }, 20_000);

    return {
      write: (pcm) => {
        if (closed) return;
        if (!ready) {
          if (backlog.length < 50) backlog.push(pcm);
          return;
        }
        if (ws.readyState === WebSocket.OPEN) sendAudio(pcm);
      },
      close: () => {
        clearInterval(keepAlive);
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input_audio_buffer.done' }));
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };
  }
}
