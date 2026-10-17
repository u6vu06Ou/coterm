import type { TerminalLabel } from "@shared/types";

/**
 * Warroom identity colour (1.5.45).
 *
 * The requirement is "stable colour by group name — same group, same colour".
 * That rules out hashing the whole label (room + group) and rules out any
 * random/alternating palette. A pure hash of `group` gives exactly the
 * property asked for: two windows of the same group always land on the same
 * hue, on every client, across reloads, with no shared registry to keep in
 * sync between the desktop app and the web/mobile clients.
 *
 * FNV-1a 32-bit then an fmix32 avalanche. The avalanche matters: with the raw
 * FNV value the low bits barely move between similar names, so the board's real
 * groups (label / f1 / f2 / usage-head) collapsed onto the same slot. Not
 * cryptographic; it only needs to spread names across the palette.
 *
 * NOTE the spec is "same group ⇒ same colour", NOT "different groups ⇒
 * different colours" — an unbounded name set cannot be collision-free in a
 * finite palette, and 12 slots is already more colours than a pane strip can
 * usefully distinguish. The four fixed manual groups (1甲…4甲) are verified
 * distinct in the unit test.
 */
const PALETTE_SIZE = 12;

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // hash *= 16777619, kept in 32-bit range without Math.imul overflow.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Murmur3 finalizer — full 32-bit avalanche of the FNV value. */
function fmix32(hash: number): number {
  let value = hash;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

/** Palette slot for a group name. Exported so the test can assert spread. */
export function labelSlot(group: string): number {
  return fmix32(fnv1a(group)) % PALETTE_SIZE;
}

/**
 * Hue for a group name, in HSL degrees. Twelve evenly spaced hues, offset by
 * 12° so index 0 is not pure red (which collides with the error/destructive
 * tone used elsewhere in the chrome).
 */
export function labelHue(group: string): number {
  return Math.round((labelSlot(group) * (360 / PALETTE_SIZE) + 12) % 360);
}

/**
 * CSS colour for the top-edge band. Saturated but not neon: the band sits on
 * the pane border, so it must read at a glance without competing with the
 * active-tile blue (--dock-tile-border-active) or the attention orange.
 */
export function labelColor(label: TerminalLabel | null | undefined): string | null {
  if (!label?.group) return null;
  return `hsl(${labelHue(label.group)} 70% 55%)`;
}

/** Tooltip text: which warroom folder the window belongs to, if known. */
export function labelTitle(label: TerminalLabel | null | undefined): string | null {
  if (!label?.group) return null;
  return label.room ? `${label.group} · ${label.room}` : label.group;
}

/**
 * The four manual swatches, in the order the boss fixed (1甲 2甲 3甲 4甲).
 * Deliberately the SAME group tokens the warroom uses, so a hand-coloured pane
 * and an eyes-opened pane with the same group share one colour — the band means
 * "this window's group", not "how it was coloured".
 */
export const MANUAL_LABEL_GROUPS = ["1甲", "2甲", "3甲", "4甲"] as const;

/**
 * Next label in the manual cycle: none → 1甲 → 2甲 → 3甲 → 4甲 → none.
 * A label whose group is not one of the four (i.e. one the warroom assigned)
 * restarts the cycle at 1甲 rather than clearing, so the button never silently
 * deletes an identity the warroom set. `room` is carried over on the wrap so a
 * manual re-colour of a warroom pane does not lose its folder tooltip.
 */
export function nextManualLabel(
  current: TerminalLabel | null | undefined,
): TerminalLabel | null {
  const groups = MANUAL_LABEL_GROUPS;
  const index = current?.group ? groups.findIndex((group) => group === current.group) : -1;
  if (index < 0) return { room: current?.room ?? "", group: groups[0] };
  const group = groups[index + 1];
  if (!group) return null;
  return { room: current?.room ?? "", group };
}
