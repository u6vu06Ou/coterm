import { afterEach, describe, expect, it, vi } from "vitest";
import { PcmCapture } from "../../src/renderer/src/components/voice/pcm-capture";

interface FakePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port: FakePort = { onmessage: null, postMessage: vi.fn() };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor(_context: AudioContext, _name: string) {
    FakeAudioWorkletNode.instances.push(this);
  }
}

function makeGraph(addModule: () => Promise<void>) {
  const sourceConnect = vi.fn();
  const sourceDisconnect = vi.fn();
  const gainDisconnect = vi.fn();
  const gain = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: gainDisconnect,
  };
  const context = {
    audioWorklet: { addModule: vi.fn(addModule) },
    createGain: vi.fn(() => gain),
    destination: {},
  } as unknown as AudioContext;
  const source = {
    connect: sourceConnect,
    disconnect: sourceDisconnect,
  } as unknown as MediaStreamAudioSourceNode;
  return { context, source, sourceConnect, sourceDisconnect, gainDisconnect };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeAudioWorkletNode.instances = [];
});

describe("PcmCapture", () => {
  it("uses the supplied microphone graph and detaches the exact worklet on stop", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pcm-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const { context, source, sourceConnect, sourceDisconnect, gainDisconnect } = makeGraph(async () => undefined);
    const capture = new PcmCapture({ onPcm: vi.fn(), onError: vi.fn() });

    await capture.start(context, source);
    const worklet = FakeAudioWorkletNode.instances[0]!;
    expect(sourceConnect).toHaveBeenCalledOnce();
    expect(sourceConnect).toHaveBeenCalledWith(worklet);

    capture.stop();
    expect(sourceDisconnect).toHaveBeenCalledWith(worklet);
    expect(worklet.port.postMessage).toHaveBeenCalledWith({ type: "stop" });
    expect(worklet.port.onmessage).toBeNull();
    expect(worklet.disconnect).toHaveBeenCalledOnce();
    expect(gainDisconnect).toHaveBeenCalledOnce();
  });

  it("does not attach a worklet when stop wins while the module loads", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pcm-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    let resolveModule: (() => void) | undefined;
    const { context, source, sourceConnect } = makeGraph(() => new Promise<void>((resolve) => { resolveModule = resolve; }));
    const capture = new PcmCapture({ onPcm: vi.fn(), onError: vi.fn() });

    const starting = capture.start(context, source);
    capture.stop();
    resolveModule?.();
    await starting;

    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    expect(sourceConnect).not.toHaveBeenCalled();
  });
});
