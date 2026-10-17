// Submit guards shared by every mobile composer surface (the floating
// MobileCommandComposer and the phone reader's inline input). Pure/decision
// level — unit-tested in tests/unit/mobile-composer-dictation.test.ts.
//
// iPhone native dictation inserts and revises text through beforeinput/input
// events (insertText / insertReplacementText) and may fire composition events
// around them: the marked text stays an OPEN composition long after the user
// stops talking. Two rules follow:
//  1. Never treat those input/composition events as a submit. Only an
//     explicit Enter keydown or the Send button submits.
//  2. A Send tap is explicit final intent: take the textarea's current text
//     (the latest revision) as final and close the composition first —
//     otherwise submit() refuses while composing and the tap silently dies.

import { mobileInputController, type MobileInputController } from "./mobile-input-controller";

export interface ComposerEnterProbe {
  /** event.nativeEvent.isComposing from the Enter keydown. */
  readonly eventComposing: boolean;
  /** event.nativeEvent.keyCode — IME-processed keys arrive as 229. */
  readonly keyCode: number;
  /** mobileInputController.isComposing() at keydown time. */
  readonly controllerComposing: boolean;
}

/**
 * Enter submits the draft only as a deliberate keypress. Blocked while any
 * composition is open (IME candidate selection, dictation re-marking), and
 * blocked when the key went through IME processing (keyCode 229) even if the
 * composing flag already flipped false — some IMEs end composition before the
 * Enter that confirms the candidate.
 */
export function shouldSubmitComposerOnEnter(probe: ComposerEnterProbe): boolean {
  if (probe.eventComposing) return false;
  if (probe.keyCode === 229) return false;
  if (probe.controllerComposing) return false;
  return true;
}

/**
 * Force-resolve a still-open composition because the user tapped Send.
 * Dictation and some IMEs leave the text "marked" indefinitely
 * (2026-10-06: long dictated sentences "never printed"), and the controller's
 * submit() refuses while composing. Copying the live textarea value into the
 * draft captures the latest dictation revision that setDraft's last echo may
 * not have seen.
 */
export function forceResolveCompositionForSend(
  terminalId: string,
  textareaValue: string | null,
  controller: MobileInputController = mobileInputController,
): void {
  if (!controller.isComposing()) return;
  controller.setComposition(false);
  if (textareaValue !== null) controller.setDraft(terminalId, textareaValue);
}
