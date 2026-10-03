// Room microphone capture, Nemo's voice playback, and browser fallbacks
// (Web Speech API) used when the NVIDIA speech NIMs are not configured.

export interface Mic {
  setMuted(muted: boolean): void;
  stop(): void;
}

export async function startMic(onFrame: (pcm: ArrayBuffer) => void, onLevel?: (rms: number) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('/pcm-capture-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { processorOptions: { targetRate: 16000, chunkMs: 100 } });
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    onFrame(e.data.pcm);
    onLevel?.(e.data.rms);
  };
  src.connect(node);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);
  await ctx.resume();
  return {
    setMuted: (v) => node.port.postMessage({ type: 'mute', value: v }),
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

/**
 * Voice activity on the room mic (100 ms frames). Tracks the noise floor, reports
 * when people start/stop talking, and fires a barge-in when someone talks over
 * Nemo (with a higher threshold, since Nemo's own voice leaks into the mic).
 */
export class VoiceDetector {
  private floor = 0.006;
  private above = 0;
  private below = 0;
  private speaking = false;
  private bargeFrames = 0;
  private bargedThisTurn = false;

  constructor(
    private onChange: (speaking: boolean) => void,
    private onBargeIn: () => void,
  ) {}

  feed(rms: number, nemoSpeaking: boolean) {
    if (!nemoSpeaking) this.bargedThisTurn = false;
    const threshold = Math.max(0.015, this.floor * 3);
    if (rms < threshold && !nemoSpeaking) this.floor = this.floor * 0.97 + rms * 0.03;
    const loud = rms > threshold;
    if (loud) {
      this.above++;
      this.below = 0;
    } else {
      this.below++;
      this.above = 0;
    }
    if (!this.speaking && this.above >= 2) {
      this.speaking = true;
      this.onChange(true);
    } else if (this.speaking && this.below >= 7) {
      this.speaking = false;
      this.onChange(false);
    }
    // Barge-in: clearly louder than the echo, for 400 ms.
    if (nemoSpeaking && rms > Math.max(0.05, threshold * 2.5)) this.bargeFrames++;
    else this.bargeFrames = 0;
    if (nemoSpeaking && this.bargeFrames >= 4 && !this.bargedThisTurn) {
      this.bargedThisTurn = true;
      this.bargeFrames = 0;
      this.onBargeIn();
    }
  }
}

/** Plays streamed PCM16 mono chunks gaplessly. */
export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private rate = 22050;
  private next = 0;
  private live = new Set<AudioBufferSourceNode>();
  private carry: Uint8Array | null = null;
  private ended = true;
  private idle: number | undefined;

  constructor(private onSpeaking: (speaking: boolean) => void) {}

  unlock() {
    if (!this.ctx) this.ctx = new AudioContext();
    void this.ctx.resume();
  }

  begin(rate: number) {
    this.unlock();
    this.rate = rate;
    this.ended = false;
    clearTimeout(this.idle);
    this.onSpeaking(true);
  }

  push(chunk: ArrayBuffer) {
    const ctx = this.ctx;
    if (!ctx) return;
    let bytes = new Uint8Array(chunk);
    if (this.carry) {
      const m = new Uint8Array(this.carry.length + bytes.length);
      m.set(this.carry);
      m.set(bytes, this.carry.length);
      bytes = m;
      this.carry = null;
    }
    if (bytes.length % 2) {
      this.carry = bytes.slice(-1);
      bytes = bytes.slice(0, -1);
    }
    if (!bytes.length) return;
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    const buf = ctx.createBuffer(1, i16.length, this.rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    if (this.next < now + 0.03) this.next = now + 0.08;
    src.start(this.next);
    this.next += buf.duration;
    this.live.add(src);
    src.onended = () => {
      this.live.delete(src);
      this.maybeDone();
    };
  }

  end() {
    this.ended = true;
    this.maybeDone();
  }

  stop() {
    this.live.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    });
    this.live.clear();
    this.next = 0;
    this.ended = true;
    this.maybeDone();
  }

  private maybeDone() {
    if (!this.ended || this.live.size) return;
    clearTimeout(this.idle);
    this.idle = window.setTimeout(() => this.onSpeaking(false), 400); // room reverb tail
  }
}

/** Browser speech synthesis fallback. */
export function speakWithBrowser(text: string, onDone: () => void, lang: 'en' | 'fr' = 'en') {
  const synth = window.speechSynthesis;
  if (!synth) return onDone();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'fr' ? 'fr-FR' : 'en-US';
  u.rate = 1.04;
  u.pitch = 1.05;
  const voices = synth.getVoices();
  u.voice =
    lang === 'fr'
      ? (voices.find((v) => /Google français/i.test(v.name)) ??
        voices.find((v) => v.lang === 'fr-FR' && /Amélie|Thomas|Denise|Henri|Julie/i.test(v.name)) ??
        voices.find((v) => v.lang.startsWith('fr')) ??
        null)
      : (voices.find((v) => /Google US English/.test(v.name)) ??
        voices.find((v) => v.lang === 'en-US' && /Samantha|Aria|Jenny|Zira/.test(v.name)) ??
        voices.find((v) => v.lang.startsWith('en')) ??
        null);
  u.onend = () => setTimeout(onDone, 300);
  u.onerror = () => onDone();
  synth.cancel();
  synth.speak(u);
}

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

export function browserAsrSupported(): boolean {
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

/** Web Speech API fallback for transcription (Chrome). */
export class BrowserAsr {
  private rec: Recognition | null = null;
  private active = false;
  private paused = false;

  constructor(
    private onText: (text: string, final: boolean) => void,
    private lang: 'en' | 'fr' = 'en',
  ) {}

  start() {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) throw new Error('Speech recognition is not supported in this browser. Use Chrome.');
    this.active = true;
    const rec: Recognition = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang === 'fr' ? 'fr-FR' : 'en-US';
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        this.onText(r[0].transcript.trim(), r.isFinal);
      }
    };
    rec.onend = () => {
      if (this.active && !this.paused) setTimeout(() => this.safeStart(), 150);
    };
    rec.onerror = () => {
      /* onend restarts */
    };
    this.rec = rec;
    this.safeStart();
  }

  setPaused(paused: boolean) {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.rec?.abort();
    else this.safeStart();
  }

  stop() {
    this.active = false;
    this.rec?.abort();
  }

  private safeStart() {
    try {
      this.rec?.start();
    } catch {
      /* already started */
    }
  }
}
