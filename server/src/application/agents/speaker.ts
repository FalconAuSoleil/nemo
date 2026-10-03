import type { S2C } from '@nemo/shared';
import type { Clock, Logger, RoomPublisher, TextToSpeech } from '../ports/index.ts';

// Nemo's voice. One utterance at a time; replies jump the queue, proactive lines
// wait for a natural pause and expire if the conversation moved on.

export type SayPriority = 'reply' | 'method' | 'proactive';

interface Pending {
  id: string;
  text: string;
  priority: SayPriority;
  createdAt: number;
  ttlMs: number;
}

const RANK: Record<SayPriority, number> = { reply: 0, method: 1, proactive: 2 };

export interface SpeakerHooks {
  speakingChanged(speaking: boolean, text?: string): void;
  /** True when the room is quiet enough for Nemo to speak (stricter for proactive lines). */
  isBreakpoint(priority: SayPriority): boolean;
}

export class Speaker {
  private queue: Pending[] = [];
  private current: { id: string; abort: AbortController; safety: NodeJS.Timeout } | null = null;
  private seq = 0;
  private retry: NodeJS.Timeout | null = null;

  constructor(
    private code: string,
    private tts: TextToSpeech | null,
    private publisher: RoomPublisher,
    private clock: Clock,
    private lang: 'en' | 'fr',
    private hooks: SpeakerHooks,
    private log: Logger,
  ) {}

  get speaking(): boolean {
    return this.current !== null;
  }

  say(text: string, priority: SayPriority = 'reply', ttlMs = priority === 'proactive' ? 20_000 : 60_000) {
    const clean = text.replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    this.queue.push({ id: `say-${++this.seq}`, text: clean, priority, createdAt: this.clock.now(), ttlMs });
    this.queue.sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.createdAt - b.createdAt);
    this.pump();
  }

  /** Stops the current line (someone talked over Nemo) and drops pending proactive lines. */
  interrupt() {
    this.queue = this.queue.filter((p) => p.priority === 'reply');
    if (this.current) {
      this.current.abort.abort();
      this.publisher.toHost(this.code, { t: 'say.audio.end', id: this.current.id });
      this.finish(this.current.id);
    }
  }

  clear() {
    this.queue = [];
    if (this.current) {
      this.current.abort.abort();
      this.publisher.toHost(this.code, { t: 'say.audio.end', id: this.current.id });
      this.finish(this.current.id);
    }
  }

  /** Host reports real playback state (drives half-duplex). */
  playbackChanged(speaking: boolean) {
    if (!speaking && this.current) this.finish(this.current.id);
  }

  /** Called periodically so queued proactive lines get a chance at breakpoints. */
  pump() {
    if (this.current) return;
    const now = this.clock.now();
    this.queue = this.queue.filter((p) => now - p.createdAt < p.ttlMs);
    // Nemo never talks over people: every line waits for a pause.
    const idx = this.queue.findIndex((p) => this.hooks.isBreakpoint(p.priority));
    if (idx < 0) {
      // Check again shortly, so Nemo speaks as soon as the room pauses.
      if (this.queue.length && !this.retry) this.retry = setTimeout(() => ((this.retry = null), this.pump()), 250);
      return;
    }
    const [next] = this.queue.splice(idx, 1);
    void this.play(next);
  }

  private async play(p: Pending) {
    const abort = new AbortController();
    // Safety net in case the host never reports the end of playback.
    const estimateMs = 2500 + p.text.split(' ').length * 420;
    const safety = setTimeout(() => this.finish(p.id), estimateMs + 4000);
    this.current = { id: p.id, abort, safety };
    this.hooks.speakingChanged(true, p.text);

    if (!this.tts) {
      this.publisher.toHost(this.code, { t: 'say', id: p.id, text: p.text, lang: this.lang } satisfies S2C);
      return;
    }
    try {
      this.publisher.toHost(this.code, { t: 'say.audio.start', id: p.id, text: p.text, sampleRate: this.tts.sampleRate });
      for await (const chunk of this.tts.synthesize(p.text, abort.signal, this.lang)) {
        if (abort.signal.aborted) break;
        this.publisher.toHost(this.code, chunk);
      }
      this.publisher.toHost(this.code, { t: 'say.audio.end', id: p.id });
    } catch (err) {
      if (abort.signal.aborted) return;
      this.log.warn('TTS failed, falling back to browser voice', String(err));
      this.publisher.toHost(this.code, { t: 'say.audio.end', id: p.id });
      this.publisher.toHost(this.code, { t: 'say', id: p.id, text: p.text, lang: this.lang });
    }
  }

  private finish(id: string) {
    if (!this.current || this.current.id !== id) return;
    clearTimeout(this.current.safety);
    this.current = null;
    this.hooks.speakingChanged(false);
    setTimeout(() => this.pump(), 300);
  }
}
