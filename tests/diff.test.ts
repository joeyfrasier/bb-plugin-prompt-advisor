import { test } from "node:test";
import assert from "node:assert/strict";
import { diffWords, sameText } from "../lib/diff";

test("identical text yields a single same part", () => {
  const parts = diffWords("fix the bug", "fix the bug");
  assert.deepEqual(parts, [{ kind: "same", text: "fix the bug" }]);
});

test("a replaced phrase reads as removed then added, not word-by-word", () => {
  const parts = diffWords(
    "Please fix the login bug today",
    "Please fix the authentication bug today",
  );
  assert.deepEqual(parts, [
    { kind: "same", text: "Please fix the " },
    { kind: "removed", text: "login" },
    { kind: "added", text: "authentication" },
    { kind: "same", text: " bug today" },
  ]);
});

test("a short unchanged run between edits is glued into one edit", () => {
  // "the" between two edits is <=2 words and has edits on both sides, so it
  // is coalesced into the surrounding removed/added runs rather than its own
  // "same" part.
  const parts = diffWords("fix the old red bug", "fix the new blue bug");
  const removed = parts.find((p) => p.kind === "removed");
  const added = parts.find((p) => p.kind === "added");
  assert.ok(removed?.text.includes("old") && removed.text.includes("red"));
  assert.ok(added?.text.includes("new") && added.text.includes("blue"));
});

test("pure insertion yields only an added part beyond the shared prefix/suffix", () => {
  const parts = diffWords("fix the bug", "fix the critical bug");
  assert.deepEqual(parts, [
    { kind: "same", text: "fix the " },
    { kind: "added", text: "critical " },
    { kind: "same", text: "bug" },
  ]);
});

test("pure deletion yields only a removed part", () => {
  const parts = diffWords("fix the critical bug", "fix the bug");
  assert.deepEqual(parts, [
    { kind: "same", text: "fix the " },
    { kind: "removed", text: "critical " },
    { kind: "same", text: "bug" },
  ]);
});

test("empty before/after is handled without throwing", () => {
  assert.deepEqual(diffWords("", "fix the bug"), [
    { kind: "added", text: "fix the bug" },
  ]);
  assert.deepEqual(diffWords("fix the bug", ""), [
    { kind: "removed", text: "fix the bug" },
  ]);
  assert.deepEqual(diffWords("", ""), []);
});

test("a very large input falls back to one removed/added block instead of cell-by-cell diffing", () => {
  const before = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
  const after = Array.from({ length: 2000 }, (_, i) => `term${i}`).join(" ");
  const parts = diffWords(before, after);
  assert.deepEqual(
    parts.map((p) => p.kind),
    ["removed", "added"],
  );
  assert.equal(parts[0]!.text, before);
  assert.equal(parts[1]!.text, after);
});

test("sameText ignores whitespace differences", () => {
  assert.ok(sameText("fix  the   bug", "fix the bug"));
  assert.ok(sameText("  fix the bug  ", "fix the bug"));
  assert.ok(!sameText("fix the bug", "fix the issue"));
});
