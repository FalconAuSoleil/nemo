// Captures mono PCM16 at 16 kHz in ~100 ms frames. `sampleRate` is the worklet global.
// Each frame also reports the RMS of the raw signal (before muting), so the page
// can detect voices even while Nemo speaks (barge-in) and know when the room is quiet.
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetRate = 16000, chunkMs = 100 } = options.processorOptions || {};
    this.ratio = sampleRate / targetRate;
    this.size = Math.round((targetRate * chunkMs) / 1000);
    this.buf = new Int16Array(this.size);
    this.i = 0; this.pos = 0; this.acc = 0; this.n = 0;
    this.sq = 0; this.sqN = 0;
    this.muted = false;
    this.port.onmessage = (e) => { if (e.data && e.data.type === 'mute') this.muted = !!e.data.value; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.acc += ch[k]; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let raw = this.acc / this.n;
        this.acc = 0; this.n = 0;
        raw = raw > 1 ? 1 : raw < -1 ? -1 : raw;
        this.sq += raw * raw; this.sqN++;
        const s = this.muted ? 0 : raw;
        this.buf[this.i++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.i === this.size) {
          const rms = Math.sqrt(this.sq / Math.max(1, this.sqN));
          this.sq = 0; this.sqN = 0;
          this.port.postMessage({ pcm: this.buf.buffer, rms }, [this.buf.buffer]);
          this.buf = new Int16Array(this.size); this.i = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
