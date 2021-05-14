import "./text-decoder";

import initialize, { Processor } from "../target/wasm-pack/processor";

class CustomWorklet extends AudioWorkletProcessor {
  constructor() {
    super();

    this.port.addEventListener("message", this.message.bind(this));
    this.port.start();
  }

  message(content) {
    const type = content.data?.type;
    if (type === "panic") {
      this.panic()
    } else if (type === "processor") {
      initialize(content.data.buffer)
        .then(() => this.port.postMessage({ type: "initialized" }));
    }
  }

  process([input,], [output,], _parameters) {
    const n = input.length; // number of channels

    if (n === 0 || n !== output.length)
      return false;

    if (!this.processors || this.processors.length !== n)
      this.processors = Array(n).fill().map(_ => new Processor(sampleRate));

    this.processors.forEach((p, k) => p.process(input[k], output[k]));

    return true;
  }

  panic() {
    if (this.processors)
      this.processors.forEach(p => p.panic());
  }
}

registerProcessor("effect-processor", CustomWorklet);
