// Phase 6: production capture + speaker wiring for the panel. jsdom-free
// seams live in mic.ts/tts.ts; this module only adapts the real browser
// objects to the coordinator contract.

import type { VoiceAgentCapture, VoiceAgentCaptureResult } from "./agent-coordinator";
import { agentAudioConstraints } from "./mic";
import { VadEndpointController } from "@shared/voice-vad";

/**
 * Browser fallback VAD constants. These are deliberately centralized instead
 * of scattered magic numbers so the LiveKit/Silero adapter can be tuned
 * against the same product-level endpoint policy later.
 */
export const BROWSER_VAD_OPTIONS = {
  rmsThreshold: 0.055,
  consecutiveSpeechFrames: 2,
  frameMs: 40,
  silenceMs: 900,
  minSpeechMs: 180,
  maxUtteranceMs: 45_000,
} as const;

/**
 * MediaRecorder-backed take recorder. The stream opens once and is kept
 * across presses (whisper hallucinates out of a freshly reopened mic), so
 * the AudioContext/analyser doubles as the barge-in monitor during speaking.
 */
export function createMediaRecorderCapture(): VoiceAgentCapture {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let deferredStop: { resolve: (result: VoiceAgentCaptureResult | null) => void } | null = null;
  let cancelled = false;
  let captureGeneration = 0;
  const speechStartListeners = new Set<() => void>();
  const utteranceEndListeners = new Set<() => void>();
  let vadTimer: ReturnType<typeof setInterval> | null = null;
  let loudFrames = 0;
  let analyser: AnalyserNode | null = null;
  let sampleBuffer: Float32Array<ArrayBuffer> | null = null;
  const endpoint = new VadEndpointController({
    silenceMs: BROWSER_VAD_OPTIONS.silenceMs,
    minSpeechMs: BROWSER_VAD_OPTIONS.minSpeechMs,
    maxUtteranceMs: BROWSER_VAD_OPTIONS.maxUtteranceMs,
  });

  async function ensureStream(): Promise<MediaStream> {
    if (stream?.getAudioTracks().some((track) => track.readyState === "live")) {
      // iOS suspends the context on Control Center mic-mode switches, screen
      // lock and audio-session flips; nothing else ever wakes it back up.
      if (context && context.state !== "running") void context.resume().catch(() => undefined);
      return stream;
    }
    stream = await navigator.mediaDevices.getUserMedia(agentAudioConstraints());
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (stream && !stream.getAudioTracks().some((item) => item.readyState === "live")) stream = null;
      });
    }
    context = new AudioContext();
    context.onstatechange = () => {
      if (context && context.state !== "running") void context.resume().catch(() => undefined);
    };
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    sampleBuffer = new Float32Array(analyser.fftSize);
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    return stream;
  }

  function startVadMonitor(): void {
    if (vadTimer || !analyser || !sampleBuffer) return;
    vadTimer = setInterval(() => {
      if (!analyser || !sampleBuffer) return;
      // Heartbeat resume: a context suspended mid-session (iOS interruptions)
      // feeds the analyser zeros forever, which reads as "user never speaks".
      if (context && context.state !== "running") void context.resume().catch(() => undefined);
      analyser.getFloatTimeDomainData(sampleBuffer);
      let sum = 0;
      for (let index = 0; index < sampleBuffer.length; index += 1) {
        sum += sampleBuffer[index]! * sampleBuffer[index]!;
      }
      const rms = Math.sqrt(sum / sampleBuffer.length);
      const now = Date.now();
      if (rms >= BROWSER_VAD_OPTIONS.rmsThreshold) {
        loudFrames += 1;
      } else if (loudFrames > 0) {
        loudFrames = 0;
      }
      const speech = loudFrames >= BROWSER_VAD_OPTIONS.consecutiveSpeechFrames;
      for (const event of endpoint.observe({ speech, atMs: now })) {
        if (event.type === "speech-started") {
          for (const listener of speechStartListeners) listener();
        } else {
          for (const listener of utteranceEndListeners) listener();
        }
      }
    }, BROWSER_VAD_OPTIONS.frameMs);
  }

  function stopVadMonitor(): void {
    if (vadTimer) clearInterval(vadTimer);
    vadTimer = null;
    loudFrames = 0;
    endpoint.reset();
  }

  return {
    start() {
      cancelled = false;
      chunks = [];
      endpoint.reset();
      loudFrames = 0;
      const generation = ++captureGeneration;
      void ensureStream().then((activeStream) => {
        if (cancelled || generation !== captureGeneration) return;
        const next = new MediaRecorder(activeStream);
        recorder = next;
        next.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        next.onstop = () => {
          const pending = deferredStop;
          deferredStop = null;
          if (!pending) return;
          if (cancelled || chunks.length === 0) {
            pending.resolve(null);
            return;
          }
          const blob = new Blob(chunks, { type: next.mimeType || "audio/webm" });
          void blob.arrayBuffer().then((buffer) => {
            pending.resolve({ audio: new Uint8Array(buffer), mimeType: blob.type });
          }).catch(() => pending.resolve(null));
        };
        next.start();
        startVadMonitor();
      }).catch(() => {
        // Mic genuinely unavailable/denied: the Take resolves empty below and
        // the coordinator falls back to idle without pretending audio worked.
        deferredStop?.resolve(null);
        deferredStop = null;
      });
    },
    stop(): Promise<VoiceAgentCaptureResult | null> {
      captureGeneration += 1;
      if (speechStartListeners.size === 0 && utteranceEndListeners.size === 0) stopVadMonitor();
      return new Promise((resolve) => {
        const current = recorder;
        recorder = null;
        if (!current || current.state === "inactive") {
          resolve(null);
          return;
        }
        deferredStop = { resolve };
        current.stop();
      });
    },
    cancel() {
      cancelled = true;
      captureGeneration += 1;
      stopVadMonitor();
      const current = recorder;
      recorder = null;
      if (current && current.state !== "inactive") current.stop();
      deferredStop?.resolve(null);
      deferredStop = null;
    },
    onSpeechStart(callback: () => void): () => void {
      speechStartListeners.add(callback);
      // The coordinator subscribes only while TTS is speaking. Starting the
      // analyser here keeps VAD alive after the recorder take has stopped,
      // which makes hands-free barge-in a real production path.
      void ensureStream().then(startVadMonitor).catch(() => undefined);
      return () => {
        speechStartListeners.delete(callback);
        if (speechStartListeners.size === 0 && utteranceEndListeners.size === 0 && recorder?.state !== "recording") {
          stopVadMonitor();
        }
      };
    },
    onUtteranceEnd(callback: () => void): () => void {
      utteranceEndListeners.add(callback);
      void ensureStream().then(startVadMonitor).catch(() => undefined);
      return () => {
        utteranceEndListeners.delete(callback);
        if (speechStartListeners.size === 0 && utteranceEndListeners.size === 0 && recorder?.state !== "recording") {
          stopVadMonitor();
        }
      };
    },
  };
}

/** JSON-safe base64 for the authenticated web RPC audio channel (§11.5). */
export function encodeAudioBase64(audio: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < audio.length; offset += chunk) {
    binary += String.fromCharCode(...audio.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
