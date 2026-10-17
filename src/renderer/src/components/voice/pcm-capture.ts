/**
 * AudioWorklet PCM tap for WhisperEngine's existing MediaStream graph.
 *
 * This class deliberately never calls getUserMedia: preview and final must use
 * the same microphone stream. WhisperEngine owns stream lifetime and passes its
 * AudioContext/source node here when a streaming-preview session starts.
 */

export interface PcmCaptureCallbacks {
  onPcm: (samples: Float32Array) => void;
  onError: (error: string) => void;
}

const WORKLET_CODE = `
class CotermPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.flushSize = 1600;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "stop") {
        this.stopped = true;
        this.buffer = [];
      }
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    for (let i = 0; i < channel.length; i += 1) this.buffer.push(channel[i]);
    if (this.buffer.length >= this.flushSize) {
      const chunk = new Float32Array(this.buffer);
      this.buffer = [];
      this.port.postMessage(chunk, [chunk.buffer]);
    }
    return true;
  }
}
registerProcessor("coterm-pcm-capture", CotermPcmCaptureProcessor);
`;

export const CAPTURE_SAMPLE_RATE = 16_000;

export class PcmCapture {
  private workletNode: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private startSequence = 0;

  constructor(private readonly callbacks: PcmCaptureCallbacks) {}

  isSupported(context?: AudioContext): boolean {
    return Boolean(
      context?.audioWorklet &&
      typeof AudioWorkletNode !== "undefined",
    );
  }

  async start(context: AudioContext, sourceNode: MediaStreamAudioSourceNode): Promise<void> {
    if (this.workletNode || !this.isSupported(context)) return;
    const sequence = ++this.startSequence;
    try {
      const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      // stop() may win while the worklet module is loading. Do not attach a
      // late preview tap after the recording has already ended.
      if (sequence !== this.startSequence) return;
      const workletNode = new AudioWorkletNode(context, "coterm-pcm-capture");
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data instanceof Float32Array) this.callbacks.onPcm(event.data);
      };
      sourceNode.connect(workletNode);
      workletNode.connect(silentGain);
      silentGain.connect(context.destination);
      this.workletNode = workletNode;
      this.silentGain = silentGain;
      this.sourceNode = sourceNode;
    } catch (error) {
      this.stop();
      this.callbacks.onError(error instanceof Error ? error.message : String(error));
    }
  }

  stop(): void {
    this.startSequence += 1;
    if (this.workletNode) {
      try { this.workletNode.port.postMessage({ type: "stop" }); } catch { /* already detached */ }
      try { this.sourceNode?.disconnect(this.workletNode); } catch { /* already detached */ }
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    this.silentGain?.disconnect();
    this.silentGain = null;
    this.sourceNode = null;
  }
}
