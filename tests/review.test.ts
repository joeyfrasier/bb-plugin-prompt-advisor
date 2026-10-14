import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewPrompt,
  parseReview,
  validateRecommendations,
  reviewSelectionSchema,
  remapMentions,
} from "../lib/review";

const selection = reviewSelectionSchema.parse({
  projectId: "p1",
  hostId: "h1",
  providerId: "codex",
  model: "sol",
  reasoningLevel: "high",
  serviceTier: "default",
});
const model = {
  providerId: "codex",
  model: "sol",
  label: "Sol",
  description: "General coding",
  reasoningLevels: ["low", "medium", "high"],
  serviceTiers: ["default", "ultrafast"],
};
const catalog = {
  targets: [
    {
      id: "p1:h1",
      projectId: "p1",
      projectName: "App",
      hostId: "h1",
      machineName: "Dev",
      platform: "linux",
      models: [model],
    },
    {
      id: "p2:h2",
      projectId: "p2",
      projectName: "Personal",
      hostId: "h2",
      machineName: "Mac",
      platform: "darwin",
      models: [{ ...model, serviceTiers: ["default"] }],
    },
  ],
  warnings: [],
};
const review = (recommendations: unknown[] = []) =>
  JSON.stringify({
    prompt: "Fix src/a.ts",
    summary: "Clarified the outcome.",
    questions: [],
    recommendations,
  });

test("parses structured advice and preserves the draft references", () => {
  assert.equal(
    parseReview(review(), "Fix src/a.ts", []).prompt,
    "Fix src/a.ts",
  );
  assert.throws(() => parseReview(review(), "Fix src/b.ts", []), /references/);
});
test("rejects unsupported reasoning and speed on the proposed machine", () => {
  const advice = parseReview(
    review([
      {
        field: "target",
        value: "p2:h2",
        reason: "Needs macOS",
        confidence: 0.9,
      },
      {
        field: "serviceTier",
        value: "ultrafast",
        reason: "Fast",
        confidence: 0.9,
      },
    ]),
    "Fix src/a.ts",
    [],
  );
  assert.throws(
    () => validateRecommendations(selection, advice.recommendations, catalog),
    /service tier/,
  );
});
test("a valid downgrade changes only approved fields", () => {
  const advice = parseReview(
    review([
      {
        field: "reasoningLevel",
        value: "low",
        reason: "Bounded edit",
        confidence: 0.95,
      },
    ]),
    "Fix src/a.ts",
    [],
  );
  const result = validateRecommendations(
    selection,
    advice.recommendations,
    catalog,
  );
  assert.equal(result.reasoningLevel, "low");
  assert.equal(result.projectId, "p1");
  assert.equal(result.model, "sol");
});
test("unknown targets and duplicate recommendations fail closed", () => {
  const advice = parseReview(
    review([
      { field: "target", value: "not-real", reason: "Guess", confidence: 0.9 },
    ]),
    "Fix src/a.ts",
    [],
  );
  assert.throws(
    () => validateRecommendations(selection, advice.recommendations, catalog),
    /target/,
  );
  assert.throws(
    () =>
      parseReview(
        review([
          {
            field: "model",
            value: "sol",
            providerId: "codex",
            reason: "x",
            confidence: 1,
          },
          {
            field: "model",
            value: "other",
            providerId: "codex",
            reason: "y",
            confidence: 1,
          },
        ]),
        "Fix src/a.ts",
        [],
      ),
    /Duplicate/,
  );
});
test("a low confidence change is shown but cannot be applied", () => {
  const advice = parseReview(
    review([
      {
        field: "reasoningLevel",
        value: "low",
        reason: "Guess",
        confidence: 0.4,
      },
    ]),
    "Fix src/a.ts",
    [],
  );
  assert.throws(
    () => validateRecommendations(selection, advice.recommendations, catalog),
    /confidence/,
  );
});
test("draft is treated as data and the reviewer is instructed to avoid actions", () => {
  const prompt = buildReviewPrompt(
    "Deploy the site now",
    selection,
    catalog,
    0,
    "Keep my voice",
  );
  assert.ok(prompt.includes("Do not execute"));
  assert.ok(prompt.includes("Never invent"));
  assert.ok(prompt.includes("success"));
  assert.ok(prompt.includes("ultrafast"));
  assert.ok(prompt.includes("Keep my voice"));
});
test("remaps repeated structured references and refuses a lost occurrence", () => {
  const mentions = [
    { from: 0, to: 5, id: "one" },
    { from: 10, to: 15, id: "two" },
  ];
  const mapped = remapMentions(
    "@note and @note",
    "Please use @note and @note.",
    mentions,
  );
  assert.deepEqual(
    mapped.map((x) => [x.from, x.to]),
    [
      [11, 16],
      [21, 26],
    ],
  );
  assert.throws(
    () => remapMentions("@note and @note", "Use @note.", mentions),
    /mention/,
  );
});
