import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReferences,
  formatMissing,
  missingReferences,
} from "../lib/references";

test("extracts file paths, mentions, urls, and code spans", () => {
  const refs = extractReferences(
    "fix src/auth/login.ts per @readme, see https://example.com/docs and run `npm test`",
  );
  assert.ok(refs.includes("src/auth/login.ts"));
  assert.ok(refs.includes("@readme"));
  assert.ok(refs.includes("https://example.com/docs"));
  assert.ok(refs.includes("npm test"));
});

test("email addresses are not treated as @mentions", () => {
  const refs = extractReferences("mail dev@example.com about it");
  assert.ok(!refs.some((token) => token.startsWith("@")));
});

test("plain prose yields no references", () => {
  assert.deepEqual(
    extractReferences("make the login page look better and fix the crash"),
    [],
  );
});

test("slash prose and unmarked ambiguous forms can be rephrased", () => {
  for (const prose of [
    "who/what",
    "who/what/when",
    "and/or",
    "input/output",
    "read/write",
    "yes/no",
    "on/off",
    "pass/fail",
    "Monday/Tuesday",
    "owner/team",
    "foo/bar",
  ]) {
    const original = `Explain ${prose}.`;
    assert.deepEqual(extractReferences(original), [], prose);
    assert.deepEqual(
      missingReferences(original, "Explain the alternatives."),
      [],
      prose,
    );
  }
});

test("path syntax and common relative directories remain protected", () => {
  for (const path of [
    "src/auth/login.ts",
    "docs/auth.md",
    "src/auth",
    "lib/references",
    "tests/fixtures",
    "scripts/check",
    "custom/widget.ts",
    ".github/workflows",
    "config/.env.example",
    "./foo/bar",
    "../foo/bar",
    "~/foo/bar",
    "/foo/bar",
    "/etc/hosts",
    "/tmp",
    "./README",
    "../README",
    "~/project",
    "foo/bar/",
  ]) {
    const original = `Check ${path}.`;
    assert.deepEqual(extractReferences(original), [path], path);
    assert.deepEqual(missingReferences(original, "Check it."), [path], path);
    assert.deepEqual(
      missingReferences(original, `Please check ${path}.`),
      [],
      path,
    );
  }
});

test("explicit reference context protects ambiguous slash forms", () => {
  for (const original of [
    "Use `foo/bar`.",
    "Use @foo/bar.",
    "Check path foo/bar.",
    "Check the directory foo/bar.",
    'Check file: "foo/bar".',
    "Check repository foo/bar.",
    "Check endpoint foo/bar.",
  ]) {
    assert.ok(
      missingReferences(original, "Check it.").some((ref) =>
        ref.includes("foo/bar"),
      ),
      original,
    );
  }
  assert.deepEqual(
    missingReferences("Check foo/bar.", "Check it.", ["foo/bar"]),
    ["foo/bar"],
  );
});

test("reference labels protect coordinated lists and stop at resumed prose", () => {
  for (const original of [
    "Check paths foo/bar and baz/qux.",
    "Check files foo/bar, baz/qux.",
    'Check directories "foo/bar", and "baz/qux".',
    "Check repositories foo/bar or baz/qux.",
    "Check paths `foo/bar` and baz/qux.",
    "Check paths foo/bar and/or baz/qux.",
  ]) {
    assert.deepEqual(
      extractReferences(original),
      ["foo/bar", "baz/qux"],
      original,
    );
    assert.deepEqual(
      missingReferences(original, "Check paths foo/bar."),
      ["baz/qux"],
      original,
    );
  }
  assert.deepEqual(
    extractReferences("Check paths foo/bar, baz/qux, and other/thing."),
    ["foo/bar", "baz/qux", "other/thing"],
  );
  assert.deepEqual(
    extractReferences(
      "Check paths foo/bar and then explain who/what and read/write.",
    ),
    ["foo/bar"],
  );
});

test("reference labels protect Markdown path lists within their list boundary", () => {
  for (const original of [
    "Check these paths:\n- foo/bar\n- baz/qux",
    "Check these paths:\n\n* foo/bar\n* baz/qux",
    "Check these files:\n1. foo/bar\n2. baz/qux",
    "Check these paths:\r\n+ `foo/bar`\r\n+ baz/qux",
  ]) {
    assert.deepEqual(
      extractReferences(original),
      ["foo/bar", "baz/qux"],
      original,
    );
    assert.deepEqual(
      missingReferences(original, "Check the relevant paths."),
      ["foo/bar", "baz/qux"],
      original,
    );
  }
  assert.deepEqual(extractReferences("Check paths:\n- foo/bar\n\n- who/what"), [
    "foo/bar",
  ]);
  assert.deepEqual(
    extractReferences(
      "Check paths:\n- foo/bar\n- explain who/what and read/write",
    ),
    ["foo/bar"],
  );
});

test("mixed prose cannot hide dropped references", () => {
  const original =
    "Explain who/what and read/write using src/auth, ./foo/bar, (https://example.com/who/what), `who/what`, and @owner/team";
  const enhanced =
    "Explain the people and permissions using src/auth, ./foo/bar, (https://example.com/who/what), who/what, and @owner/team";
  assert.deepEqual(missingReferences(original, enhanced), []);
  for (const reference of [
    "src/auth",
    "./foo/bar",
    "https://example.com/who/what",
    "@owner/team",
  ]) {
    assert.ok(
      missingReferences(original, enhanced.replace(reference, "it")).includes(
        reference,
      ),
      reference,
    );
  }
});

test("missingReferences flags only dropped tokens", () => {
  const original = "update docs/auth.md and src/auth/session.ts";
  const enhanced = "Update src/auth/session.ts and refresh the auth docs.";
  assert.deepEqual(missingReferences(original, enhanced), ["docs/auth.md"]);
});

test("code-span content preserved without backticks still counts", () => {
  const original = "run `npm test` after";
  const enhanced = "Run npm test afterwards.";
  assert.deepEqual(missingReferences(original, enhanced), []);
});

test("nothing missing when everything survives", () => {
  const text = "fix src/a.ts per https://x.dev and @notes";
  assert.deepEqual(missingReferences(text, `Rewritten: ${text}`), []);
});

test("known mention labels are verified exactly, not heuristically", () => {
  const original = "summarize @meeting notes and clean up the doc";
  const enhanced = "Summarize the meeting notes and clean up the document.";
  // Regex alone finds "@meeting"; the structured label is ground truth.
  assert.deepEqual(missingReferences(original, enhanced, ["@meeting notes"]), [
    "@meeting",
    "@meeting notes",
  ]);
  const preserved = "Summarize @meeting notes and clean up the document.";
  assert.deepEqual(
    missingReferences(original, preserved, ["@meeting notes"]),
    [],
  );
});

test("known tokens absent from the original are ignored", () => {
  // A stale label from a previous draft must not produce a false warning.
  assert.deepEqual(missingReferences("do the thing", "Do it.", ["@stale"]), []);
});

test("formatMissing lists up to three then elides", () => {
  assert.equal(formatMissing(["a/b", "c/d"]), "a/b, c/d");
  assert.equal(formatMissing(["a/b", "c/d", "e/f", "g/h"]), "a/b, c/d, e/f, …");
});

test("a URL is not also reported as a bare path", () => {
  const refs = extractReferences(
    "follow https://stripe.com/docs/idempotency and patch src/pay.ts",
  );
  assert.ok(refs.includes("https://stripe.com/docs/idempotency"));
  assert.ok(refs.includes("src/pay.ts"));
  assert.ok(!refs.includes("stripe.com/docs/idempotency"));
});
