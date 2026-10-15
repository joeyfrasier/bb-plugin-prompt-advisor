import { test } from "node:test";
import assert from "node:assert/strict";
import { looksFinished, pauseLabel, shortcutLabel } from "../lib/trigger";
import { diffWords, sameText } from "../lib/diff";

test("automatic review waits for a finished sentence", () => {
  for (const text of [
    "Fix the login bug.",
    "Can you check this?",
    "Ship it!",
    "Use `npm test`",
    'Rename it to "Inbox"',
    "See the docs (README.md)",
    "Run this:\n```sh\nnpm test\n```",
    "Done.  \n",
  ])
    assert.equal(looksFinished(text), true, text);
  for (const text of [
    "",
    "I want to enhance the",
    "First, I want to make the delay",
    "Fix these:",
    "1. Faster reviews,",
    "Run this:\n```sh\nnpm test",
    "Check src/a.ts",
  ])
    assert.equal(looksFinished(text), false, text);
});

test("labels name the shortcut and pause", () => {
  assert.equal(shortcutLabel("MacIntel"), "⌃⇧R");
  assert.equal(shortcutLabel("Linux x86_64"), "Ctrl+Shift+R");
  assert.equal(pauseLabel(60000), "1 minute");
  assert.equal(pauseLabel(120000), "2 minutes");
  assert.equal(pauseLabel(45000), "45 seconds");
});

test("word diff marks only changed words and round-trips both texts", () => {
  const before = "Fix the bug in src/a.ts quickly.";
  const after = "Please fix the crash in src/a.ts.";
  const parts = diffWords(before, after);
  const join = (kinds: string[]) =>
    parts
      .filter((p) => kinds.includes(p.kind))
      .map((p) => p.text)
      .join("");
  assert.equal(join(["same", "removed"]), before);
  assert.equal(join(["same", "added"]), after);
  // Edits separated by a short unchanged word read as one replacement.
  assert.deepEqual(diffWords("one two three", "uno two tres"), [
    { kind: "removed", text: "one two three" },
    { kind: "added", text: "uno two tres" },
  ]);
  assert.deepEqual(
    diffWords(
      "Keep this paragraph.\n\nFix it.",
      "Keep this paragraph.\n\nPlease fix it.",
    ),
    [
      { kind: "same", text: "Keep this paragraph.\n\n" },
      { kind: "removed", text: "Fix" },
      { kind: "added", text: "Please fix" },
      { kind: "same", text: " it." },
    ],
  );
  assert.deepEqual(diffWords("same", "same"), [{ kind: "same", text: "same" }]);
});

test("whitespace-only differences are not a rewrite", () => {
  assert.equal(sameText("Fix it.\n", "  Fix   it."), true);
  assert.equal(sameText("Fix it.", "Fix it now."), false);
});
