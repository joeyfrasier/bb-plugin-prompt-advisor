import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { reviewSelectionSchema } from "../lib/review";

const selection = reviewSelectionSchema.parse({
  projectId: "p1",
  hostId: "h1",
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "high",
  serviceTier: "default",
});
const input = {
  scopeKey: "compose-1",
  fingerprint: "draft-1",
  text: "Fix src/a.ts",
  selection,
  mentionLabels: [],
  attachmentCount: 0,
};
const wait = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(fn(), "expected async operation to finish");
};
const provider = {
  id: "codex",
  available: true,
  serviceTiers: [{ id: "default" }, { id: "ultrafast" }],
  capabilities: { modelCatalogScope: "host" },
};
const model = {
  model: "gpt-6.1-sol",
  displayName: "Sol 6.1",
  description: "General coding",
  isDefault: true,
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "medium" },
    { reasoningEffort: "high" },
  ],
  supportedServiceTiers: [{ id: "default" }, { id: "ultrafast" }],
};
async function setup(spawn?: () => Promise<unknown>) {
  const host = createFakePluginHost({
    pluginId: "prompt-advisor",
    experimental_callHostRpc: () => ({ platform: "linux" }),
    sdk: {
      projects: {
        list: async () => [
          {
            id: "p1",
            name: "App",
            kind: "standard",
            sources: [{ hostId: "h1", path: "/app", isDefault: true }],
          },
          { id: "personal", name: "Personal", kind: "personal", sources: [] },
        ],
      },
      hosts: { list: async () => [makeHostResponse({ id: "h1" })] },
      system: { config: async () => ({ primaryHostId: "h1" }) },
      providers: {
        list: async () => [provider],
        models: async () => ({ models: [model] }),
      },
      threads: {
        spawn: spawn ?? (async () => ({ id: "review-child" })),
        get: async () =>
          makeThreadResponse({ id: "review-child", status: "active" }),
        stop: async () => ({ ok: true }),
        delete: async () => ({ ok: true }),
      },
    },
  });
  await plugin(host.bb);
  return host;
}

test("one hidden reviewer is deduplicated, uses its own model, and sends no task actions", async () => {
  const { harness } = await setup();
  try {
    const first = (await harness.behavior.callRpc("startReview", input)) as {
      id: string;
    };
    const second = (await harness.behavior.callRpc("startReview", input)) as {
      id: string;
    };
    assert.equal(first.id, second.id);
    await wait(
      () => harness.inspection.sdk.callsTo("threads.spawn").length === 1,
    );
    const spawned = harness.inspection.sdk.callsTo(
      "threads.spawn",
    )[0]![0] as Record<string, unknown>;
    assert.equal(spawned.projectId, "personal");
    assert.equal(spawned.model, "gpt-6.1-sol");
    assert.equal(spawned.reasoningLevel, "medium");
    assert.equal(spawned.serviceTier, "ultrafast");
    assert.equal(spawned.visibility, "hidden");
    assert.equal(spawned.permissionMode, "accept-edits");
    assert.equal(spawned.parentThreadId, undefined);
    assert.match(String(spawned.prompt), /Do not execute/);
    assert.equal(
      harness.inspection.sdk.callsTo("providers.models").length,
      1,
      "projects share one machine catalogue",
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("idle completion persists a review across reload and validates a supported downgrade", async () => {
  let { harness } = await setup();
  try {
    const first = (await harness.behavior.callRpc("startReview", input)) as {
      id: string;
    };
    await wait(
      () => harness.inspection.sdk.callsTo("threads.spawn").length === 1,
    );
    await new Promise((r) => setImmediate(r));
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "review-child" }),
      lastAssistantText: JSON.stringify({
        prompt: "Fix src/a.ts",
        summary: "Bounded edit.",
        questions: [],
        recommendations: [
          {
            field: "reasoningLevel",
            value: "low",
            reason: "Simple local edit.",
            confidence: 0.9,
          },
        ],
      }),
    });
    const done = (await harness.behavior.callRpc("getReview", {
      id: first.id,
    })) as { status: string };
    assert.equal(done.status, "done");
    harness = (await harness.lifecycle.reload(plugin)).harness;
    const resumed = (await harness.behavior.callRpc("resume", {
      scopeKey: input.scopeKey,
    })) as { id: string };
    assert.equal(resumed.id, first.id);
    const result = (await harness.behavior.callRpc("validateSettings", {
      id: first.id,
      fields: ["reasoningLevel"],
      selection,
    })) as { selection: { reasoningLevel: string } };
    assert.equal(result.selection.reasoningLevel, "low");
    await assert.rejects(
      () =>
        harness.behavior.callRpc("validateSettings", {
          id: first.id,
          fields: ["reasoningLevel"],
          selection: { ...selection, model: "changed" },
        }),
      /Settings changed/,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a late spawn after cancellation is reaped and never delivered", async () => {
  let finish!: (value: unknown) => void;
  const { harness } = await setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const first = (await harness.behavior.callRpc("startReview", input)) as {
      id: string;
    };
    await wait(() => typeof finish === "function");
    await harness.behavior.callRpc("dismiss", { id: first.id });
    finish({ id: "late-child" });
    await wait(
      () => harness.inspection.sdk.callsTo("threads.delete").length === 1,
    );
    const result = (await harness.behavior.callRpc("getReview", {
      id: first.id,
    })) as { status: string };
    assert.equal(result.status, "cancelled");
    assert.equal(
      await harness.behavior.callRpc("resume", { scopeKey: input.scopeKey }),
      null,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a missing reference fails review without altering the original", async () => {
  const { harness } = await setup();
  try {
    const first = (await harness.behavior.callRpc("startReview", input)) as {
      id: string;
    };
    await wait(
      () => harness.inspection.sdk.callsTo("threads.spawn").length === 1,
    );
    await new Promise((r) => setImmediate(r));
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "review-child" }),
      lastAssistantText: JSON.stringify({
        prompt: "Fix it",
        summary: "Changed.",
        questions: [],
        recommendations: [],
      }),
    });
    const result = (await harness.behavior.callRpc("getReview", {
      id: first.id,
    })) as { status: string; original: string };
    assert.equal(result.status, "error");
    assert.equal(result.original, input.text);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("answers start a fresh review that carries the earlier rewrite", async () => {
  const { harness } = await setup();
  try {
    const first = (await harness.behavior.callRpc("startReview", input)) as {
      id: string;
    };
    await wait(
      () => harness.inspection.sdk.callsTo("threads.spawn").length === 1,
    );
    await new Promise((r) => setImmediate(r));
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "review-child" }),
      lastAssistantText: JSON.stringify({
        prompt: "Please fix the crash in src/a.ts.",
        changes: ["Named the outcome"],
        questions: [
          { question: "Which crash?", options: ["On load", "On save"] },
        ],
        recommendations: [],
      }),
    });
    const answers = [{ question: "Which crash?", answer: "On save" }];
    const refined = (await harness.behavior.callRpc("startReview", {
      ...input,
      refineFrom: first.id,
      answers,
    })) as { id: string; answers: unknown };
    assert.notEqual(refined.id, first.id);
    assert.deepEqual(refined.answers, answers);
    const again = (await harness.behavior.callRpc("startReview", {
      ...input,
      refineFrom: first.id,
      answers,
    })) as { id: string };
    assert.equal(again.id, refined.id, "identical answers are deduplicated");
    await wait(
      () => harness.inspection.sdk.callsTo("threads.spawn").length === 2,
    );
    const prompt = String(
      (
        harness.inspection.sdk.callsTo("threads.spawn")[1]![0] as {
          prompt: string;
        }
      ).prompt,
    );
    assert.match(prompt, /REFINEMENT/);
    assert.ok(
      prompt.includes('"previousPrompt":"Please fix the crash in src/a.ts."'),
    );
    assert.ok(prompt.includes('"answer":"On save"'));
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("answers without the review they belong to are rejected", async () => {
  const { harness } = await setup();
  try {
    await assert.rejects(() =>
      harness.behavior.callRpc("startReview", {
        ...input,
        answers: [{ question: "Which crash?", answer: "On save" }],
      }),
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
