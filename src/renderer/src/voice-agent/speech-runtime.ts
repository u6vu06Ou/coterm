import { browserSpeechProvider } from "./tts";
import { SpeechArbiter, type SpeechRole, type SpeechRoleProfile } from "./speech-arbiter";

let shared: SpeechArbiter | null = null;

/** Renderer-wide acoustic owner. Panel replies, background narration and
 * Settings previews all share this single arbiter, so preview cannot overlap
 * a live supervisor/session voice. */
export function getBrowserSpeechArbiter(
  profileFor: (role: SpeechRole) => SpeechRoleProfile,
): SpeechArbiter | null {
  if (shared) return shared;
  const provider = browserSpeechProvider();
  if (!provider) return null;
  shared = new SpeechArbiter(provider, { profileFor });
  return shared;
}

export function resetBrowserSpeechArbiter(): void {
  shared?.dispose();
  shared = null;
}
