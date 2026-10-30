import { useSyncExternalStore } from "react";
import type { ReadAloudResponse } from "@shared/types";
import { translate, normalizeLocale } from "../i18n";
import { useAppStore } from "../store/app-store";

/**
 * Pane 朗讀 player (2026-10-30 maintainer). One press speaks a spoken-script
 * summary of what the agent did since the user's last prompt — the user is
 * driving and cannot read. Single global playback: two panes talking over
 * each other is pure noise, so starting one stops the other.
 *
 * Playback path: main returns the summary script + an Edge-TTS mp3 (base64).
 * We play the mp3 in an <audio> element from a blob: URL — on phones this
 * keeps playing on a locked screen once started (speechSynthesis dies there),
 * and MediaSession gives the lock-screen/headset play/pause keys. No audio
 * bytes (TTS down) → browser speechSynthesis fallback.
 */

export type ReadAloudStatus = "idle" | "loading" | "playing";

interface PlayerState {
  status: ReadAloudStatus;
  terminalId: string | null;
}

let state: PlayerState = { status: "idle", terminalId: null };
const listeners = new Set<() => void>();
/** Monotonic press counter: a slow RPC that resolves after the user pressed
 *  stop (or started another pane) must not start speaking anyway. */
let generation = 0;

function setState(next: PlayerState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React hook for the per-pane button state. */
export function useReadAloudStatus(terminalId: string): ReadAloudStatus {
  const current = useSyncExternalStore(subscribe, () => state);
  if (current.terminalId !== terminalId) return "idle";
  return current.status;
}

let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let toastEl: HTMLDivElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function t(key: "dock.readAloud.failed" | "dock.readAloud.empty"): string {
  return translate(normalizeLocale(useAppStore.getState().settings?.locale), key);
}

function showToast(text: string, sticky = false): void {
  clearToast();
  toastEl = document.createElement("div");
  toastEl.className = "read-aloud-toast";
  toastEl.textContent = text;
  document.body.appendChild(toastEl);
  // The script text stays while it is spoken (so the user can verify the
  // machine said the right thing), then lingers a moment after playback.
  if (!sticky) toastTimer = setTimeout(clearToast, 6_000);
}

function clearToast(): void {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastEl?.remove();
  toastEl = null;
}

function clearMediaSession(): void {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.setActionHandler("play", null);
    navigator.mediaSession.setActionHandler("pause", null);
  } catch {
    /* best effort */
  }
}

/** Stop whatever is speaking (both the audio element and speechSynthesis). */
export function stopReadAloud(): void {
  generation += 1;
  if (audio) {
    audio.pause();
    audio.src = "";
    audio = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* speechSynthesis may be absent */
  }
  clearMediaSession();
  clearToast();
  setState({ status: "idle", terminalId: null });
}

function playSynthesized(script: string, gen: number, title: string): void {
  const synth = window.speechSynthesis;
  if (!synth) {
    showToast(script);
    setState({ status: "idle", terminalId: null });
    return;
  }
  const utterance = new SpeechSynthesisUtterance(script);
  utterance.lang = "zh-TW";
  const voice = synth.getVoices().find((v) => /zh[-_](TW|HK)/i.test(v.lang));
  if (voice) utterance.voice = voice;
  utterance.rate = 1.1;
  utterance.onend = utterance.onerror = () => {
    if (gen !== generation) return;
    clearMediaSession();
    if (toastEl) toastTimer = setTimeout(clearToast, 1_500);
    setState({ status: "idle", terminalId: null });
  };
  synth.speak(utterance);
  setMediaSession(title, {
    play: () => undefined,
    pause: () => synth.cancel(),
  });
}

function setMediaSession(title: string, handlers: { play: () => void; pause: () => void }): void {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: "Coterm 朗讀" });
    navigator.mediaSession.setActionHandler("play", handlers.play);
    navigator.mediaSession.setActionHandler("pause", handlers.pause);
  } catch {
    /* MediaSession unsupported — playback still works */
  }
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Toggle for a pane: idle → fetch + play; loading/playing → stop. Returns
 * once playback has started (or stopped), so the button state settles fast.
 */
export async function toggleReadAloud(terminalId: string, title: string): Promise<void> {
  if (state.terminalId === terminalId && state.status !== "idle") {
    stopReadAloud();
    return;
  }
  if (state.status !== "idle") stopReadAloud();
  const gen = ++generation;
  setState({ status: "loading", terminalId });
  let result: ReadAloudResponse;
  try {
    result = await window.aiTerminal.requestReadAloud(terminalId);
  } catch {
    if (gen !== generation) return;
    showToast(t("dock.readAloud.failed"));
    setState({ status: "idle", terminalId: null });
    return;
  }
  if (gen !== generation) return; // user stopped while the summary cooked
  if (!result.ok || !result.script) {
    showToast(result.error === "busy" ? t("dock.readAloud.failed") : t("dock.readAloud.empty"));
    setState({ status: "idle", terminalId: null });
    return;
  }
  const script = result.script;
  setState({ status: "playing", terminalId });
  showToast(script, true);
  const clip = result.audio;
  if (!clip || clip.bytes <= 0) {
    playSynthesized(script, gen, title);
    return;
  }
  objectUrl = URL.createObjectURL(base64ToBlob(clip.base64, clip.mime));
  audio = new Audio(objectUrl);
  audio.onended = () => {
    if (gen !== generation) return;
    // Leave the script toast up a breath after the voice stops, then settle.
    if (toastEl) toastTimer = setTimeout(clearToast, 1_500);
    clearMediaSession();
    if (audio) {
      URL.revokeObjectURL(objectUrl ?? "");
      objectUrl = null;
      audio = null;
    }
    setState({ status: "idle", terminalId: null });
  };
  audio.onerror = () => {
    if (gen !== generation) return;
    playSynthesized(script, gen, title);
  };
  setMediaSession(title, {
    play: () => void audio?.play().catch(() => undefined),
    pause: () => audio?.pause(),
  });
  try {
    await audio.play();
  } catch {
    // Autoplay-policy rejection (should not happen inside a click handler) or
    // decode failure — fall back to the browser voice so the press is never
    // a dud.
    if (gen !== generation) return;
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    audio = null;
    playSynthesized(script, gen, title);
  }
}
