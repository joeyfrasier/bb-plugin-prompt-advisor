export const DEFAULT_PAUSE_MS = 60_000;
// Automatic reviews never run closer together than this, whatever the pause.
export const MIN_AUTOMATIC_GAP_MS = 15_000;
// Physical Control on every platform: ⌘⇧R is hard reload in Mac browsers and Electron.
export const REVIEW_SHORTCUT = {
  key: "r",
  control: true,
  shift: true,
} as const;

/**
 * Whether a draft reads as finished enough to review automatically. Drafts
 * that stop mid-sentence wait for the shortcut or Review now instead.
 */
export function looksFinished(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  // A closed code fence ends a draft as well as punctuation does.
  if (trimmed.endsWith("```"))
    return (trimmed.match(/```/g) ?? []).length % 2 === 0;
  return /[.!?…)\]"'”’`]$/u.test(trimmed);
}

export function shortcutLabel(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  return /mac|iphone|ipad/i.test(platform) ? "⌃⇧R" : "Ctrl+Shift+R";
}

export function pauseLabel(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return `${Math.round(ms / 1000)} seconds`;
}
