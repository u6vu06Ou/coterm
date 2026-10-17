export const browserCapabilities = {
  evaluate: true,
  upload: true,
  // B4 (§12.2): gated by the browser.superpowersP1 Settings flag at dispatch
  // (page.download carries tier p1); without the flag it fails closed.
  download: true,
} as const;

export type BrowserCapability = keyof typeof browserCapabilities;

export function isBrowserCapabilityEnabled(capability: BrowserCapability): boolean {
  return browserCapabilities[capability];
}
