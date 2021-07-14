import initialize, { Processor } from "../target/wasm-pack/processor";

export const enum State {
  Closed = 0,
  Open = 1,
  Running = 2,
}

enum AudioError {
  NotStarted = "NOT_STARTED",
  Insecure = "مطمئن شوید این صفحه با پروتکل امن http<strong>s</strong>) بارگزاری شده است.",
  Unsupported = "متأسفانه مروگر شما پشتیبانی نمی‌شود. لطفاً از فایرفاکس ۷۶ یا جدیدتر، و یا کروم ۶۵ یا جدیدتر استفاده کنید.",
}

type EffectNode = AudioWorkletNode | ScriptProcessorNode;

type _TupleOf<T, N extends number, R extends unknown[]> = R["length"] extends N ? R : _TupleOf<T, N, [T, ...R]>;
export type Tuple<T, N extends number> = N extends N ? number extends N ? T[] : _TupleOf<T, N, []> : never;

export const numCanvases = 3;
export type Canvases = Tuple<HTMLCanvasElement, typeof numCanvases>;

export default class Audio {
  private is_open = false;
  private is_started = false;

  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private effect?: EffectNode;
  private visualyser?: VisualiserNode;

  get state() {
    return this.is_started ? State.Running :
      this.is_open ? State.Open : State.Closed;
  }

  panic() {
    if (this.state !== State.Closed)
      this.effect?.dispatchEvent(new Event("panic"));
  }

  async open(canvases: Canvases, fftSize: number) {
    if (this.is_open)
      return;

    if (!(
      navigator.mediaDevices &&
      AudioContext &&
      (AudioWorkletNode || ScriptProcessorNode)
    ))
      throw isSecureContext === false ?
        AudioError.Insecure :
        AudioError.Unsupported;

    this.context ??= new AudioContext();

    this.stream ??= await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      }
    });

    this.source ??= this.context.createMediaStreamSource(this.stream);

    this.effect ??= await makeEffectNode(this.context);

    this.visualyser ??= new VisualiserNode(this.context, canvases, { fftSize });

    this.is_open = true;
  }

  start() {
    if (!this.is_open)
      throw AudioError.NotStarted;

    if (!this.is_started) {
      this.is_started = true;

      this.source!.connect(this.effect!);
      this.effect!.connect(this.visualyser!);
      this.visualyser!.connect(this.context!.destination);
    }
  }

  stop() {
    if (!this.is_open)
      throw AudioError.NotStarted;

    if (this.is_started) {
      this.is_started = false;

      this.source!.disconnect(this.effect!);
      this.effect!.disconnect(this.visualyser!);
      this.visualyser!.disconnect(this.context!.destination);
    }
  }

  async close() {
    if (!this.is_open)
      return;

    if (this.is_started)
      this.stop();

    if (this.stream)
      this.stream.getTracks()
        .forEach(track => track.stop());
    delete this.stream;

    delete this.source;
    delete this.effect;

    this.visualyser?.recanvas();
    delete this.visualyser;

    if (this.context)
      await this.context.close();
    delete this.context;

    this.is_open = false;
  }

  recanvas(canvases?: Canvases) {
    this.visualyser?.recanvas(canvases);
  }
}

interface GetData {
  (buffer: Uint8Array): void;
}

class VisualiserNode extends AnalyserNode implements AudioNode {
  private visualisers: [WaveformVisualiser, SpectrumVisualiser, SpectrogramVisualiser];
  private draw_handle?: number;

  constructor(context: BaseAudioContext, canvases: Canvases, options?: AnalyserOptions) {
    super(context, options);

    const [waveformCanvas, spectrumCanvas, spectrogramCanvas] = canvases;
    const waveform = new WaveformVisualiser(waveformCanvas, this.fftSize);
    const spectrum = new SpectrumVisualiser(spectrumCanvas, this.frequencyBinCount);
    const spectrogram = new SpectrogramVisualiser(spectrogramCanvas, this.frequencyBinCount);
    this.visualisers = [waveform, spectrum, spectrogram];
  }

  recanvas(canvases?: Canvases) {
    this.visualisers.map((v, i) => v.recanvas(canvases && canvases[i]));
  }

  // initially i thought using typescript would save time catching bugs, but as
  // it turns out it is very powerful at wasting time over stupid and simple
  // matters.
  // I spent almost 2 hours fighting with the compiler over that function which
  // has more than one signature on the parent class.
  //
  // More info: https://stackoverflow.com/a/59538756/4491972
  connect(...args: any[]): AudioNode & void {
    // @ts-ignore
    const result = super.connect(...args);

    if (this.draw_handle === undefined)
      this.draw(0);

    return result;
  }

  disconnect(...args: any[]): void {
    // @ts-ignore
    super.disconnect(...args);

    if (this.draw_handle !== undefined) {
      cancelAnimationFrame(this.draw_handle);
      delete this.draw_handle;
    }
  }

  private draw(time: DOMHighResTimeStamp) {
    this.draw_handle = requestAnimationFrame(this.draw.bind(this));

    const [waveform, spectrum, spectrogram] = this.visualisers;
    waveform.draw(time, this.getByteTimeDomainData.bind(this));
    spectrum.draw(time, this.getByteFrequencyData.bind(this));
    spectrogram.draw(time, this.getByteFrequencyData.bind(this));
  }
}

interface Visualiser {
  recanvas(canvas?: HTMLCanvasElement): void;
  draw(time: DOMHighResTimeStamp, getData: GetData): void;
}

class WaveformVisualiser implements Visualiser {
  private buffer: Uint8Array;
  private context!: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, length: number) {
    this.recanvas(canvas);
    this.buffer = new Uint8Array(length);
  }

  recanvas(canvas?: HTMLCanvasElement) {
    canvas ??= this.context.canvas;

    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const context = canvas.getContext("2d");
    if (!context)
      throw new TypeError("Cannot get rendering context for visualiser canvas");

    context.fillStyle = "#aad8d3";
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.strokeStyle = "#393e46";
    context.lineWidth = 2;
    this.context = context;
  }

  draw(_time: DOMHighResTimeStamp, getData: GetData) {
    getData(this.buffer);

    const { context } = this;
    const { width, height } = context.canvas;

    context.fillRect(0, 0, width, height);

    context.beginPath();

    for (const [i, v] of this.buffer.entries()) {
      const x = i * width * 1.0 / this.buffer.length;
      const y = v * height / 255.0;
      i ? context.lineTo(x, y) : context.moveTo(x, y);
    }

    context.lineTo(width, height / 2);
    context.stroke();
  }
}

class SpectrumVisualiser implements Visualiser {
  private buffer: Uint8Array;
  private context!: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, length: number) {
    this.recanvas(canvas);
    this.buffer = new Uint8Array(length);
  }

  recanvas(canvas?: HTMLCanvasElement) {
    canvas ??= this.context.canvas;

    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const context = canvas.getContext("2d");
    if (!context)
      throw new TypeError("Cannot get rendering context for visualiser canvas");

    context.fillStyle = "#aad8d3";
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.strokeStyle = "#393e46";
    context.lineWidth = 2;
    this.context = context;
  }

  draw(_time: DOMHighResTimeStamp, getData: GetData) {
    getData(this.buffer);

    const { context } = this;
    const { width, height } = context.canvas;

    context.fillRect(0, 0, width, height);

    context.beginPath();

    const entries = this.buffer.entries();
    const x_scale = width * 1.0 / Math.log10(this.buffer.length - 1);
    entries.next();
    for (const [i, v] of entries) {
      const x = Math.log10(i) * x_scale;
      const y = (1 - v / 255.0) * height;
      i ? context.lineTo(x, y) : context.moveTo(x, y);
    }

    context.lineTo(width, height);
    context.stroke();
  }
}

class SpectrogramVisualiser implements Visualiser {
  private buffer: Uint8Array;
  private data?: ImageData;
  private context!: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, length: number) {
    this.buffer = new Uint8Array(length);
    this.recanvas(canvas);
  }

  recanvas(canvas?: HTMLCanvasElement) {
    canvas ??= this.context.canvas;

    canvas.width = this.buffer.length;
    canvas.height = canvas.offsetHeight * canvas.width / canvas.offsetWidth;

    const context = canvas.getContext("2d");
    if (!context)
      throw new TypeError("Cannot get rendering context for visualiser canvas");

    const { width, height } = canvas;
    context.fillStyle = "#aad8d3";
    context.fillRect(0, 0, width, height);
    this.context = context;

    delete this.data;
  }

  draw(_time: DOMHighResTimeStamp, getData: GetData) {
    getData(this.buffer);

    const { context } = this;
    const { width, height } = context.canvas;

    if (!this.data) {
      //context.fillStyle = "black";
      context.fillRect(0, 0, width, 1);

      this.data = context.getImageData(0, 0, width, height);
    }

    const { data } = this.data;
    data.copyWithin(context.canvas.width << 2, 0);

    const a = Math.pow(this.buffer.length - 1, 1.0 / (width - 1));
    let f = 1;
    for (let i = 0; i < width; i++) {
      const v = interpolate(this.buffer, f);
      f *= a;

      const j = i << 2, l = v / 255.0, h = (0 + l) / 5;
      const q = l < 0.5 ? l * 2 : 1, p = 2 * l - q;
      data[j  ] = 255 * hue2rgb(p, q, h + 1 / 3);
      data[j+1] = 255 * hue2rgb(p, q, h);
      data[j+2] = 255 * hue2rgb(p, q, h - 1 / 3);
    }

    this.context.putImageData(this.data, 0, 0);
  }
}

function hue2rgb(p: number, q: number, t: number): number {
  t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
  return t < 1 / 6 ? p + (q - p) * 6 * t
    : t < 1 / 2 ? q
    : t < 2 / 3 ? p + (q - p) * 6 * (2 / 3 - t)
    : p;
}

function interpolate(b: Uint8Array, x: number): number {
  const h = Math.ceil(x), l = h - 1, d = x - l;
  const H = b[h], L = b[l];
  return L + (H - L) * d;
}

async function makeEffectNode(context: AudioContext): Promise<EffectNode> {
  const url = new URL("processor.wasm", window.location.href);

  const worklet = await makeWorkletNode(context, url);
  if (worklet)
    return worklet;

  await initialize(url);

  let processors = [0, 0].map(_ => new Processor(context.sampleRate));
  const effect = context.createScriptProcessor();

  effect.addEventListener("audioprocess", (event: any) => {
    let { inputBuffer, outputBuffer } = event;
    for (let c = 0; c < outputBuffer.numberOfChannels; c++) {
      const x = inputBuffer.getChannelData(c);
      const y = outputBuffer.getChannelData(c);
      processors[c].process(x, y);
    }
  });

  effect.addEventListener("panic", () => processors.forEach(p => p.panic()));

  return effect;
}

async function makeWorkletNode(context: AudioContext, url: URL): Promise<AudioWorkletNode | void> {
  if (!context.audioWorklet)
    return;

  const response = await fetch(url.href);
  const buffer = await response.arrayBuffer();

  await context.audioWorklet.addModule("worklet.js");

  let effect: AudioWorkletNode;
  try {
    effect = new AudioWorkletNode(context, Processor.id());
  } catch (error) {
    if (error.name === "InvalidStateError")
      return;
    throw error;
  }

  const container: { handler?: EventListener } = {};
  type Resolver = (arg: any) => void;
  const initialized: Promise<void> = new Promise((resolve: Resolver, reject: Resolver) => {
    container.handler = ((content: MessageEvent) => {
      const map: any = { resolve, reject };
      const { type, error } = content.data;
      if (map.hasOwnProperty(type))
        (map[type])(error);
      else
        console.error("invalid message:", content.data);
    }) as EventListener;
    effect.port.addEventListener("message", container.handler);
  })

  effect.port.start();
  effect.port.postMessage({ type: "processor", buffer });

  try {
    await initialized;
  } catch (e) {
    console.warn("AudioWorklet init failed:", e);
    return;
  }

  (effect as EventTarget).removeEventListener("message", container.handler!);

  effect.addEventListener("panic", () => effect.port.postMessage({ type: "panic" }));
  return effect;
}
