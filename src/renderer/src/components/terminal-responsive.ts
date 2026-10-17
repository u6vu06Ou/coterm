/**
 * A phone remains in the single-terminal layout after rotating to landscape.
 * The coarse-pointer guard keeps short desktop browser windows in desktop mode.
 *
 * Landscape phones are ~390-500px tall in CSS px, so the coarse threshold sits
 * at 620px: above every phone yet below tablets (>= 700px). (#34)
 * NOTE: styles.css mirrors these query strings by hand (search
 * "max-height: 620px") — any threshold change must be applied there too.
 */
export const MOBILE_LAYOUT_QUERY =
  "(max-width: 600px), ((pointer: coarse) and (max-height: 620px))";

export const NARROW_LAYOUT_QUERY =
  "(max-width: 820px), ((pointer: coarse) and (max-height: 620px))";

/** Reset only the remote host pan; the xterm buffer/PTY geometry stays 1:1. */
export function resetRemoteHorizontalPan(host: Pick<HTMLElement, "scrollLeft">): void {
  host.scrollLeft = 0;
}

export function applyRemoteHorizontalTouchPan(
  host: Pick<HTMLElement, "scrollLeft">,
  fingerDeltaX: number,
): void {
  host.scrollLeft -= fingerDeltaX;
}
