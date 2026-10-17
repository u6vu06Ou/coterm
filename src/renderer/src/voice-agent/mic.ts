// Phase 6 (§11.5): mic capability + constraint policy, shared verbatim
// between desktop and mobile. Pure + seam-driven: jsdom tests inject the
// environment bits instead of pretending getUserMedia exists.
//
// Spec obligations encoded HERE (not in components):
//   - getUserMedia only works in a SECURE context (HTTPS / loopback). An
//     insecure context must produce an explicit, displayable reason — never
//     a dead button that fails silently, and never a pretend success.
//   - echoCancellation / noiseSuppression / autoGainControl are requested
//     when (and only when) the UA reports supporting them.
//   - the "is supported" decision never implies the STT *server* exists —
//     that error surfaces at turn time with its own message.

export type AgentMicBlockReason =
  | "insecure-context"
  | "no-media-devices";

export interface AgentMicSupport {
  supported: boolean;
  reason: AgentMicBlockReason | null;
}

export interface AgentMicEnvironment {
  isSecureContext: boolean;
  mediaDevices: {
    getUserMedia?: (constraints: unknown) => Promise<unknown>;
    getSupportedConstraints?: () => Record<string, boolean>;
  } | null;
}

export function currentAgentMicEnvironment(
  overrides: Partial<AgentMicEnvironment> = {},
): AgentMicEnvironment {
  const globalScope = globalThis as unknown as {
    isSecureContext?: boolean;
    navigator?: { mediaDevices?: AgentMicEnvironment["mediaDevices"] };
  };
  return {
    // Default false when unknown: never report support we cannot prove.
    isSecureContext: overrides.isSecureContext ?? globalScope.isSecureContext === true,
    mediaDevices: overrides.mediaDevices !== undefined
      ? overrides.mediaDevices
      : globalScope.navigator?.mediaDevices ?? null,
  };
}

export function probeAgentMicSupport(environment: AgentMicEnvironment = currentAgentMicEnvironment()): AgentMicSupport {
  if (!environment.isSecureContext) {
    // §11.5: an insecure context shows a clear explanation; we neither hide
    // the mic behind a dead button nor pretend HTTP-LAN audio can work.
    return { supported: false, reason: "insecure-context" };
  }
  if (typeof environment.mediaDevices?.getUserMedia !== "function") {
    return { supported: false, reason: "no-media-devices" };
  }
  return { supported: true, reason: null };
}

/** Constraints policy (§11.5): request suppression features only when the
 * UA advertises them — unsupported constraints are silently ignored by the
 * spec, but being explicit keeps the intent testable. */
export function buildAgentAudioConstraints(
  supportedConstraints: Record<string, boolean>,
): { audio: Record<string, boolean> } {
  const audio: Record<string, boolean> = {};
  for (const feature of ["echoCancellation", "noiseSuppression", "autoGainControl"] as const) {
    if (supportedConstraints[feature] === true) audio[feature] = true;
  }
  return { audio };
}

/** Convenience: resolves the real UA constraint request. */
export function agentAudioConstraints(
  environment: AgentMicEnvironment = currentAgentMicEnvironment(),
): { audio: Record<string, boolean> } {
  const supported = environment.mediaDevices?.getSupportedConstraints?.() ?? {};
  return buildAgentAudioConstraints(supported);
}
