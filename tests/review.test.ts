import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewPrompt,
  parseReview,
  validateRecommendations,
  reviewSelectionSchema,
  MIN_RECOMMENDATION_CONFIDENCE,
  type Catalog,
} from "../lib/review";

const selection = reviewSelectionSchema.parse({
  providerId: "codex",
  model: "sol",
  reasoningLevel: "medium",
  serviceTier: "default",
});

const catalog: Catalog = {
  providers: [
    {
      id: "codex",
      displayName: "Codex",
      models: [
        {
          model: "sol",
          displayName: "Sol",
          isDefault: true,
          reasoningLevels: ["low", "medium", "high"],
          defaultReasoningLevel: "medium",
          serviceTiers: ["default", "ultrafast"],
        },
        {
          model: "sol-max",
          displayName: "Sol Max",
          isDefault: false,
          reasoningLevels: ["high", "xhigh"],
          defaultReasoningLevel: "high",
          serviceTiers: ["default"],
        },
      ],
    },
  ],
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

test("accepts slash-prose rewrites while rejecting dropped real references", () => {
  const original =
    "Explain who/what can read/write using src/auth and ./foo/bar.";
  const prompt = "Explain who can read and write using src/auth and ./foo/bar.";
  const response = (text: string) =>
    JSON.stringify({
      prompt: text,
      changes: ["Clarified the people and permissions"],
      questions: [],
      recommendations: [],
    });
  assert.equal(parseReview(response(prompt), original, []).prompt, prompt);
  for (const reference of ["src/auth", "./foo/bar"]) {
    assert.throws(
      () =>
        parseReview(response(prompt.replace(reference, "it")), original, []),
      /dropped references/,
    );
  }
});

test("rejects an unsupported reasoning level or service tier on the recommended model", () => {
  const advice = parseReview(
    review([
      {
        field: "reasoningLevel",
        value: "xhigh",
        reason: "Needs deeper reasoning",
        confidence: 0.9,
      },
    ]),
    "Fix src/a.ts",
    [],
  );
  assert.throws(
    () => validateRecommendations(selection, advice.recommendations, catalog),
    /Unsupported reasoning level/,
  );
  const tierAdvice = parseReview(
    review([
      {
        field: "serviceTier",
        value: "ultrafast",
        reason: "Fast",
        confidence: 0.9,
      },
      {
        field: "model",
        value: "sol-max",
        providerId: "codex",
        reason: "Needs more headroom",
        confidence: 0.9,
      },
      {
        field: "reasoningLevel",
        value: "high",
        reason: "Matches the new model",
        confidence: 0.9,
      },
    ]),
    "Fix src/a.ts",
    [],
  );
  // sol-max only supports the "default" tier.
  assert.throws(
    () =>
      validateRecommendations(selection, tierAdvice.recommendations, catalog),
    /Unsupported service tier/,
  );
});

test("a valid change applies only the approved fields", () => {
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
  assert.equal(result.providerId, "codex");
  assert.equal(result.model, "sol");
});

test("an unavailable provider or model fails closed", () => {
  const advice = parseReview(
    review([
      {
        field: "model",
        value: "nope",
        providerId: "unknown-provider",
        reason: "Guess",
        confidence: 0.9,
      },
    ]),
    "Fix src/a.ts",
    [],
  );
  assert.throws(
    () => validateRecommendations(selection, advice.recommendations, catalog),
    /provider is no longer available/,
  );
  const unknownModel = parseReview(
    review([
      {
        field: "model",
        value: "nope",
        providerId: "codex",
        reason: "Guess",
        confidence: 0.9,
      },
    ]),
    "Fix src/a.ts",
    [],
  );
  assert.throws(
    () =>
      validateRecommendations(selection, unknownModel.recommendations, catalog),
    /model is unavailable/,
  );
});

test("duplicate recommendations for the same field are rejected", () => {
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
            value: "sol-max",
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

test("a low confidence recommendation is shown but cannot be applied", () => {
  const advice = parseReview(
    review([
      {
        field: "reasoningLevel",
        value: "low",
        reason: "Guess",
        confidence: MIN_RECOMMENDATION_CONFIDENCE - 0.01,
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

test("no recommendations leaves the selection untouched", () => {
  const result = validateRecommendations(selection, [], catalog);
  assert.deepEqual(result, selection);
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
  assert.ok(prompt.includes("Keep my voice"));
  // No cross-host target concept in the ported design.
  assert.doesNotMatch(prompt, /\btarget\b/);
});

test("the settings rubric requires high reasoning for tool access", () => {
  const prompt = buildReviewPrompt(
    "look into why openclaw makes dup threads",
    selection,
    catalog,
    0,
    "",
  );
  assert.match(prompt, /recommend high reasoning as the minimum/);
  assert.match(prompt, /never choose ultra solely for this rule/);
});

test("reviews carry terse changes and answerable questions; older reviews still load", () => {
  const current = parseReview(
    JSON.stringify({
      prompt: "Fix src/a.ts",
      changes: ["Named the outcome"],
      questions: [{ question: "Which crash?", options: ["On load"] }],
      recommendations: [],
    }),
    "Fix src/a.ts",
    [],
  );
  assert.deepEqual(current.questions, [
    { question: "Which crash?", options: ["On load"] },
  ]);
  assert.deepEqual(current.changes, ["Named the outcome"]);
  const legacy = parseReview(review(), "Fix src/a.ts", []);
  assert.deepEqual(legacy.changes, []);
  assert.equal(legacy.summary, "Clarified the outcome.");
  const legacyQuestion = parseReview(
    JSON.stringify({
      prompt: "Fix src/a.ts",
      summary: "x",
      questions: ["Which crash?"],
      recommendations: [],
    }),
    "Fix src/a.ts",
    [],
  );
  assert.deepEqual(legacyQuestion.questions, [
    { question: "Which crash?", options: [] },
  ]);
});

test("the rubric asks for a substantive rewrite without widening authority", () => {
  const prompt = buildReviewPrompt(
    "look into why openclaw makes dup threads",
    selection,
    catalog,
    0,
    "",
  );
  assert.match(prompt, /not a light copy-edit/);
  assert.match(prompt, /must not become permission to change things/);
  assert.match(prompt, /never complete a trailing fragment/);
  assert.match(prompt, /"changes"/);
  assert.doesNotMatch(prompt, /REFINEMENT/);
  const refined = buildReviewPrompt(
    "look into why openclaw makes dup threads",
    selection,
    catalog,
    0,
    "",
    {
      previousPrompt: "Investigate duplicate threads.",
      answers: [{ question: "Which surface?", answer: "Slack" }],
    },
  );
  assert.match(refined, /REFINEMENT/);
  assert.match(refined, /never as a Q&A appendix/);
  assert.ok(
    refined.includes('"previousPrompt":"Investigate duplicate threads."'),
  );
});
