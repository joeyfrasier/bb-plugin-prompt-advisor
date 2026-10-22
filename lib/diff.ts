export type DiffPart = { kind: "same" | "added" | "removed"; text: string };

// Above this many cells the table costs more than the view is worth.
const MAX_CELLS = 1_500_000;

/**
 * Word-level diff for reading a rewrite: a deleted phrase, then its
 * replacement, rather than alternating single words.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  return coalesce(tokenDiff(before, after));
}

// A short unchanged run between edits ("the", "and to") joins them into one edit.
const isGlue = (text: string) =>
  !text.includes("\n") && text.trim().split(/\s+/).length <= 2;

function coalesce(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let i = 0;
  while (i < parts.length) {
    if (parts[i]!.kind === "same") {
      out.push(parts[i++]!);
      continue;
    }
    let removed = "",
      added = "";
    while (i < parts.length) {
      const part = parts[i]!;
      if (part.kind === "removed") removed += part.text;
      else if (part.kind === "added") added += part.text;
      else if (
        isGlue(part.text) &&
        parts[i + 1] &&
        parts[i + 1]!.kind !== "same"
      ) {
        removed += part.text;
        added += part.text;
      } else break;
      i++;
    }
    if (removed) out.push({ kind: "removed", text: removed });
    if (added) out.push({ kind: "added", text: added });
  }
  return out;
}

/** Words and the whitespace runs between them are tokens. */
function tokenDiff(before: string, after: string): DiffPart[] {
  const a = before.match(/\s+|[^\s]+/g) ?? [];
  const b = after.match(/\s+|[^\s]+/g) ?? [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  push("same", a.slice(0, start).join(""));
  const midA = a.slice(start, endA),
    midB = b.slice(start, endB);
  const n = midA.length,
    m = midB.length;
  if (n * m > MAX_CELLS) {
    push("removed", midA.join(""));
    push("added", midB.join(""));
  } else {
    // lengths[i][j] = LCS of midA[i:] and midB[j:]
    const width = m + 1;
    const lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lengths[i * width + j] =
          midA[i] === midB[j]
            ? lengths[(i + 1) * width + j + 1]! + 1
            : Math.max(
                lengths[(i + 1) * width + j]!,
                lengths[i * width + j + 1]!,
              );
    let i = 0,
      j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        push("same", midA[i]!);
        i++;
        j++;
      } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)
        push("removed", midA[i++]!);
      else push("added", midB[j++]!);
    }
    push("removed", midA.slice(i).join(""));
    push("added", midB.slice(j).join(""));
  }
  push("same", a.slice(endA).join(""));
  return parts;
}

export function sameText(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
}
