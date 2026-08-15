class GrokPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.samples = new Int16Array(2048);
    this.used = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  flush() {
    if (!this.used) return;
    const out = this.samples.slice(0, this.used);
    this.used = 0;
    this.port.postMessage(out.buffer, [out.buffer]);
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length || !channels[0]) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let mono = 0;
      for (let c = 0; c < channels.length; c++) mono += channels[c][i] || 0;
      mono /= channels.length;
      this.phase += 16000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const clamped = Math.max(-1, Math.min(1, mono));
      this.samples[this.used++] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      if (this.used === this.samples.length) this.flush();
    }
    return true;
  }
}

registerProcessor("grok-pcm-capture", GrokPcmCaptureProcessor);
