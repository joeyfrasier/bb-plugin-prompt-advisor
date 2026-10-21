// Live-reference extraction for the dropped-reference guard. The rewrite
// prompt tells the model to preserve these verbatim; this module verifies.

/**
 * Live references the rewriter is told to preserve verbatim: @mentions,
 * URLs, inline code spans, and paths with filesystem or reference context.
 */
export function extractReferences(text: string): string[] {
  const out = new Set<string>();
  const urls = text.match(/https?:\/\/[^\s)"']+/g) ?? [];
  for (const match of urls) out.add(match);
  for (const match of text.match(/(?:^|\s)@[\w./-]{2,}/g) ?? [])
    out.add(match.trim());
  for (const match of text.match(/`[^`\n]+`/g) ?? [])
    out.add(match.slice(1, -1));
  const labelledPaths = new Set(
    Array.from(
      text.matchAll(
        /\b(?:paths?|files?|folders?|directories|directory|repositories|repository|repos?|endpoints?|routes?)\s*[:=]?\s*(?:(?:[-*+]|\d+[.)])[ \t]+)?[`"']?/gi,
      ),
      (label) => label.index + label[0].length,
    ),
  );
  const paths =
    /(?:~\/|\.\.?\/|\/)[\w.-]+(?:\/[\w.-]+)*\/?|[\w.-]+(?:\/[\w.-]+)+\/?/g;
  let labelledPathEnd = -1;
  for (const candidate of text.matchAll(paths)) {
    // Sentence punctuation is not part of an unquoted path. Keep /.. intact.
    const match = candidate[0].endsWith("/..")
      ? candidate[0]
      : candidate[0].replace(/\.+$/, "");
    // A URL's host+path also matches the path shape. Reporting both makes the
    // dropped-reference warning list the same link twice, so keep the URL.
    if (urls.some((url) => url.includes(match))) continue;
    // A slash conjunction joins references; it is not another list entry.
    if (
      match === "and/or" &&
      labelledPathEnd >= 0 &&
      !labelledPaths.has(candidate.index)
    )
      continue;
    const labelled =
      labelledPaths.has(candidate.index) ||
      (labelledPathEnd >= 0 &&
        /^[`"']?[ \t]*(?:,\s*(?:(?:and|or)\s+)?|(?:and(?:\/or)?|or|&)\s+|\r?\n[ \t]*(?:[-*+]|\d+[.)])[ \t]+)[`"']?$/i.test(
          text.slice(labelledPathEnd, candidate.index),
        ));
    labelledPathEnd = labelled ? candidate.index + candidate[0].length : -1;
    // Bare slash alternatives (who/what, read/write, even foo/bar) are
    // ambiguous. Require path syntax, a conventional directory, or a label;
    // inline code and structured mention tokens remain protected separately.
    if (
      /^(?:~?\/|\.\.?\/)/.test(match) ||
      match.endsWith("/") ||
      /(?:^|\/)(?:\.[\w-]+|[\w-]+\.[\w.-]+)/.test(match) ||
      /^(?:src|lib|apps?|tests?|specs?|docs?|scripts?|bin|config|public|assets|packages)\//.test(
        match,
      ) ||
      labelled
    )
      out.add(match);
  }
  return [...out].filter((token) => token.length > 2);
}

/**
 * References from the original that the rewrite dropped. `knownTokens` are
 * ground-truth references the caller already has (e.g. the composer's
 * structured @-mention labels) — merged with the regex extraction so bb
 * mentions are verified exactly, not heuristically.
 */
export function missingReferences(
  original: string,
  enhanced: string,
  knownTokens: readonly string[] = [],
): string[] {
  const tokens = new Set(extractReferences(original));
  for (const token of knownTokens) {
    if (token.length > 2 && original.includes(token)) tokens.add(token);
  }
  return [...tokens].filter((token) => !enhanced.includes(token));
}

export function formatMissing(missing: string[]): string {
  const shown = missing.slice(0, 3).join(", ");
  return missing.length > 3 ? `${shown}, …` : shown;
}
