// Backend behavior against the SDK's fake host: real SQLite storage, real RPC
// validation, recorded bb.sdk calls. Each test drives one run the way bb
// would: an RPC from the composer, then the child thread's events.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const SCOPE_THREAD = "thr_scope";
const CHILD = "thr_child";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  // performance.now, not Date: some tests freeze Date.
  const deadline = performance.now() + 3_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

/**
 * A loaded plugin with one scope thread and a child whose output we control.
 * `providers`, when given, seeds the catalog the plugin pre-warms at load —
 * stubbing providers.list/models AFTER setup() is too late, since the
 * catalog is already cached (with the default empty list) by then.
 */
async function setup(
  providers?: {
    list: () => Promise<unknown[]>;
    models: (args?: { providerId?: string }) => Promise<unknown>;
  },
) {
  const child = { output: null as string | null, spawned: 0 };
  const { bb, harness } = createFakePluginHost({
    pluginId: "prompt-enhancer",
    sdk: {
      providers: providers ?? { list: async () => [] },
      projects: { list: async () => [] },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "proj_1",
            environmentId: "env_1",
            providerId: "claude-code",
            // A fresh child is at work; the fixture's default is idle.
            status: threadId.startsWith(CHILD) ? "active" : "idle",
          }),
        output: async ({ threadId }: { threadId: string }) => ({
          output: threadId.startsWith(CHILD) ? child.output : "earlier reply",
        }),
        // Each spawn is a fresh child: thr_child, thr_child-2, thr_child-3.
        spawn: async () => {
          child.spawned += 1;
          return makeThreadResponse({
            id: child.spawned === 1 ? CHILD : `${CHILD}-${child.spawned}`,
            projectId: "proj_1",
            providerId: "claude-code",
          });
        },
        stop: async () => ({}),
        delete: async () => ({}),
        events: { list: async () => [] },
      },
    },
  });
  await plugin(bb);
  const childOutputReads = () =>
    harness.inspection.sdk
      .callsTo("threads.output")
      .filter(([args]) => (args as { threadId: string }).threadId.startsWith(CHILD)).length;
  const signals = () =>
    harness.inspection.realtimeSignals.map(
      (signal) => signal.payload as { id: string; status: string; text?: string },
    );
  const startRpc = () =>
    harness.behavior.callRpc("startEnhance", {
      text: "fix the add bug pls",
      scopeKey: `thread/${SCOPE_THREAD}`,
      threadId: SCOPE_THREAD,
      projectId: null,
      attachmentCount: 0,
      previewGate: false,
      mentionLabels: [],
    }) as Promise<{ id: string; timeoutMs: number }>;
  async function start(): Promise<string> {
    const readsBefore = childOutputReads();
    const { id } = (await startRpc()) as { id: string };

    await waitFor(() => childOutputReads() > readsBefore, "the first read of the child");
    return id;
  }
  /** Waits (up to `ms`) for the run to leave pending, then returns it. */
  async function settled(id: string, ms: number) {
    const deadline = performance.now() + ms;
    while ((await enhancement(id)).status === "pending" && performance.now() < deadline) {
      await sleep(20);
    }
    return enhancement(id);
  }
  async function enhancement(id: string) {
    const { enhancement } = (await harness.behavior.callRpc("getEnhancement", {
      id,
    })) as { enhancement: { status: string; enhanced: string | null; error: string | null } };
    return enhancement;
  }
  const announce = () =>
    harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: CHILD, projectId: "proj_1" }),
      sequence: 1,
    });
  const startReviewRpc = (overrides: Record<string, unknown> = {}) =>
    harness.behavior.callRpc("startReview", {
      scopeKey: `thread/${SCOPE_THREAD}`,
      fingerprint: "fp-1",
      text: "fix the add bug pls",
      threadId: SCOPE_THREAD,
      projectId: null,
      selection: {
        providerId: null,
        model: null,
        reasoningLevel: null,
        serviceTier: null,
      },
      mentionLabels: [],
      attachmentCount: 0,
      ...overrides,
    }) as Promise<{ id: string; status: string }>;
  async function startReview(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const readsBefore = childOutputReads();
    const { id } = await startReviewRpc(overrides);
    await waitFor(() => childOutputReads() > readsBefore, "the first read of the review child");
    return id;
  }
  async function getReview(id: string) {
    return harness.behavior.callRpc("getReview", { id }) as Promise<{
      status: string;
      review: { prompt: string; recommendations: unknown[] } | null;
      catalog: { providers: unknown[] } | null;
      error: string | null;
    }>;
  }
  async function settledReview(id: string, ms: number) {
    const deadline = performance.now() + ms;
    while ((await getReview(id))!.status === "pending" && performance.now() < deadline) {
      await sleep(20);
    }
    return getReview(id);
  }
  return {
    harness,
    child,
    childOutputReads,
    signals,
    start,
    startRpc,
    enhancement,
    settled,
    announce,
    startReviewRpc,
    startReview,
    getReview,
    settledReview,
  };
}

test("reads the child only when bb announces new events, never on a timer", async () => {
  const { harness, child, childOutputReads, signals, start, enhancement, announce } =
    await setup();
  const id = await start();
  // The 400 ms poller would have read the child three more times by now.
  await sleep(1_300);
  assert.equal(childOutputReads(), 1);

  child.output = "Fix the `add` bug.";
  await announce();
  await waitFor(() => childOutputReads() === 2, "the announced read");
  await waitFor(
    () => signals().some((signal) => signal.status === "progress"),
    "the progress signal",
  );
  assert.deepEqual(
    signals().filter((signal) => signal.status === "progress"),
    [{ id, status: "progress", text: "Fix the `add` bug." }],
  );

  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: CHILD, projectId: "proj_1" }),
    lastAssistantText: "Fix the `add` bug.",
  });
  assert.equal((await enhancement(id)).status, "done");
  assert.equal((await enhancement(id)).enhanced, "Fix the `add` bug.");
  // Done means done: no further reads, even when the child announces again.
  await announce();
  await sleep(50);
  assert.equal(childOutputReads(), 2);
});

test("written output followed by a quiet child finishes the run", async () => {
  const { child, start, settled, announce } = await setup();
  const id = await start();
  child.output = "Rewritten prompt.";
  await announce();
  // thread.idle never arrives (a provider slow to tear down).
  const run = await settled(id, 2_500);
  assert.equal(run.status, "done");
  assert.equal(run.enhanced, "Rewritten prompt.");
});

test("a child that fails without an error message reports its last error event", async () => {
  const { harness, start, settled } = await setup();
  harness.inspection.sdk.stub("threads.events.list", async () => [
    { type: "provider/error", data: { message: "Rate limited" } },
  ]);
  const id = await start();
  await harness.behavior.emitThreadEvent("thread.failed", {
    thread: makeThreadResponse({ id: CHILD, projectId: "proj_1", status: "error" }),
    error: null,
  });
  const run = await settled(id, 1_000);
  assert.equal(run.status, "error");
  assert.equal(run.error, "Rate limited");
});

test("a child that ended before its watch began still resolves the run", async () => {
  const { harness, start, settled } = await setup();
  // The child failed before the plugin had the spawn reply, so its
  // thread.failed found no run; only its status tells.
  harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
    makeThreadResponse({
      id: threadId,
      projectId: "proj_1",
      environmentId: "env_1",
      providerId: "claude-code",
      status: threadId === CHILD ? "error" : "idle",
    }),
  );
  harness.inspection.sdk.stub("threads.events.list", async () => [
    { type: "provider/error", data: { message: "Rate limited" } },
  ]);
  const id = await start();
  const run = await settled(id, 1_000);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
  assert.equal(run.status, "error");
  assert.equal(run.error, "Rate limited");
});

/** bb's own error event for a provider that never came up. */
const startFailure = {
  type: "system/error",
  data: {
    code: "thread_command_failed",
    message: "Command thread.start failed",
    detail: "pi did not answer get_state in time",
  },
};

test("a provider that never starts shows bb's cause, after the retries", async () => {
  const { harness, child, start, settled } = await setup();
  harness.inspection.sdk.stub("threads.events.list", async () => [startFailure]);
  const id = await start();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitFor(() => child.spawned === attempt, `spawn ${attempt}`);
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({
        id: attempt === 1 ? CHILD : `${CHILD}-${attempt}`,
        projectId: "proj_1",
        status: "error",
      }),
      error: "Command thread.start failed",
    });
  }
  const run = await settled(id, 1_000);
  assert.equal(child.spawned, 3);
  assert.equal(run.status, "error");
  assert.equal(run.error, "The provider did not start: pi did not answer get_state in time");
});

test("a provider error shows its detail and is not retried", async () => {
  const { harness, child, start, settled } = await setup();
  harness.inspection.sdk.stub("threads.events.list", async () => [
    {
      type: "provider/error",
      data: {
        message: "Provider error",
        detail:
          "There's an issue with the selected model (claude-bogus-1). It may not exist or you may not have access to it.",
      },
    },
  ]);
  const id = await start();
  await harness.behavior.emitThreadEvent("thread.failed", {
    thread: makeThreadResponse({ id: CHILD, projectId: "proj_1", status: "error" }),
    error: "Provider error",
  });
  const run = await settled(id, 1_000);
  assert.equal(child.spawned, 1);
  assert.equal(run.status, "error");
  assert.equal(
    run.error,
    "There's an issue with the selected model (claude-bogus-1). It may not exist or you may not have access to it.",
  );
});

test("a child that streamed a long rewrite before failing still shows the cause", async () => {
  const { harness, start, settled } = await setup();
  // Like bb: oldest first by default, newest first on request, 100 a page.
  const events = [
    ...Array.from({ length: 120 }, (_, seq) => ({
      type: "item/agentMessage/delta",
      data: { delta: `chunk ${seq}` },
    })),
    { type: "provider/error", data: { message: "Provider error", detail: "Rate limit reached" } },
  ];
  harness.inspection.sdk.stub(
    "threads.events.list",
    async ({ order, limit }: { order?: "asc" | "desc"; limit?: string }) =>
      (order === "desc" ? [...events].reverse() : events).slice(0, Number(limit ?? 100)),
  );
  const id = await start();
  await harness.behavior.emitThreadEvent("thread.failed", {
    thread: makeThreadResponse({ id: CHILD, projectId: "proj_1", status: "error" }),
    error: "Provider error",
  });
  const run = await settled(id, 1_000);
  assert.equal(run.error, "Rate limit reached");
});

test("the time cap counts from the run's start, not from a retried child's", { timeout: 10_000 }, async (t) => {
  // Freeze the clock at a real instant; only Date moves, timers stay real.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { harness, child, start, settled } = await setup();
  harness.inspection.sdk.stub("threads.events.list", async () => [startFailure]);
  const startedAt = Date.now();
  const id = await start();
  // The first child takes almost the whole budget to fail to start.
  t.mock.timers.setTime(startedAt + 189_500);
  await harness.behavior.emitThreadEvent("thread.failed", {
    thread: makeThreadResponse({ id: CHILD, projectId: "proj_1", status: "error" }),
    error: "Command thread.start failed",
  });
  await waitFor(() => child.spawned === 2, "the retry");
  // The retry gets the half second the run has left, not another 190 s.
  const run = await settled(id, 2_000);
  assert.equal(run.status, "error");
  assert.equal(run.error, "The enhancement took too long and was stopped");
});

test("a retried run teaches the timeout its last child's time, not the failed ones'", { timeout: 15_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { harness, child, start, startRpc, settled } = await setup();
  harness.inspection.sdk.stub("threads.events.list", async () => [startFailure]);
  const childId = (n: number) => (n === 1 ? CHILD : `${CHILD}-${n}`);
  // Three runs whose first child spends 60 s failing to start and whose retry
  // writes the rewrite in 5 s: the adaptive timeout needs three samples.
  for (let run = 0; run < 3; run += 1) {
    const id = await start();
    t.mock.timers.setTime(Date.now() + 60_000);
    const retry = child.spawned + 1;
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: childId(child.spawned), projectId: "proj_1", status: "error" }),
      error: "Command thread.start failed",
    });
    await waitFor(() => child.spawned === retry, "the retry");
    t.mock.timers.setTime(Date.now() + 5_000);
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: childId(retry), projectId: "proj_1" }),
      lastAssistantText: "Rewritten prompt.",
    });
    assert.equal((await settled(id, 1_000)).status, "done");
  }
  // 5 s runs give the 20 s floor; timing from the click (65 s) would give 138 s.
  const next = await startRpc();
  await harness.behavior.callRpc("cancelEnhance", { id: next.id });
  assert.equal(next.timeoutMs, 20_000);
});

// ---------------------------------------------------------------------------
// Review: reuses the exact machinery exercised above (spawn/retry,
// event-driven progress, cleanup) through the same fake host. These tests
// cover the review-specific wiring: the structured-JSON child response,
// catalog snapshotting, dropped-reference rejection, and the scope/dismiss
// lifecycle — not the shared spawn/retry behavior, already covered above.
// ---------------------------------------------------------------------------

function reviewResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    prompt: "Fix the add bug.",
    changes: ["Named the outcome"],
    questions: [],
    recommendations: [],
    ...overrides,
  });
}

test("a review child's structured JSON becomes a stored, validated review", async () => {
  const { harness, child, startReview, settledReview } = await setup({
    list: async () => [
      { id: "claude-code", displayName: "Claude Code", available: true },
    ],
    models: async () => ({
      models: [
        {
          model: "sol",
          displayName: "Sol",
          isDefault: true,
          description: "General coding",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "high", description: "" },
          ],
          supportedServiceTiers: [{ id: "default" }, { id: "ultrafast" }],
        },
      ],
    }),
  });
  const id = await startReview();
  child.output = reviewResponse({
    recommendations: [
      {
        field: "reasoningLevel",
        value: "high",
        reason: "Needs tool access",
        confidence: 0.9,
      },
    ],
  });
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: CHILD, projectId: "proj_1" }),
    lastAssistantText: child.output,
  });
  const run = await settledReview(id, 1_000);
  assert.equal(run!.status, "done");
  assert.equal(run!.review?.prompt, "Fix the add bug.");
  assert.equal(run!.review?.recommendations.length, 1);
  // The catalog snapshot travels with the review so the client can validate
  // recommendations itself, without a round trip back to the server.
  assert.equal(run!.catalog?.providers.length, 1);
});

test("a review that drops a live reference fails instead of landing a bad rewrite", async () => {
  const { harness, child, startReview, settledReview } = await setup();
  const id = await startReview({ text: "fix src/add.ts please" });
  child.output = reviewResponse({ prompt: "Fix it." });
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: CHILD, projectId: "proj_1" }),
    lastAssistantText: child.output,
  });
  const run = await settledReview(id, 1_000);
  assert.equal(run!.status, "error");
  assert.match(run!.error ?? "", /dropped references/);
});

test("a review that returns unparseable text fails with a retry-friendly message", async () => {
  const { harness, child, startReview, settledReview } = await setup();
  const id = await startReview();
  child.output = "not json at all";
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: CHILD, projectId: "proj_1" }),
    lastAssistantText: child.output,
  });
  const run = await settledReview(id, 1_000);
  assert.equal(run!.status, "error");
  assert.match(run!.error ?? "", /Retry; your draft is unchanged/);
});

test("starting a review with the same fingerprint returns the existing one instead of starting another", async () => {
  const { harness, child, startReviewRpc } = await setup();
  const first = await startReviewRpc();
  const second = await startReviewRpc();
  assert.equal(first.id, second.id);
  assert.equal(child.spawned, 1);
  // The review is still pending; dismiss it so its cap timer does not
  // outlive the test (every run started in a test must reach a terminal
  // state or be dismissed, same discipline the enhance tests above follow).
  await harness.behavior.callRpc("dismissReview", { id: first.id });
});

test("a new fingerprint cancels the previous pending review for the same scope", async () => {
  const { harness, child, startReviewRpc } = await setup();
  const first = await startReviewRpc();
  const second = await startReviewRpc({ fingerprint: "fp-2", text: "a different draft" });
  assert.notEqual(first.id, second.id);
  const firstRow = (await harness.behavior.callRpc("getReview", {
    id: first.id,
  })) as { status: string };
  assert.equal(firstRow.status, "cancelled");
  assert.equal(child.spawned, 2);
  // The second review is still pending; dismiss it so its cap timer does
  // not outlive the test.
  await harness.behavior.callRpc("dismissReview", { id: second.id });
});

test("resumeReviewForScope hands back the latest undismissed review for the scope", async () => {
  const { harness, startReview } = await setup();
  const id = await startReview();
  const resumed = (await harness.behavior.callRpc("resumeReviewForScope", {
    scopeKey: `thread/${SCOPE_THREAD}`,
  })) as { id: string } | null;
  assert.equal(resumed?.id, id);
  await harness.behavior.callRpc("dismissReview", { id });
  const afterDismiss = (await harness.behavior.callRpc("resumeReviewForScope", {
    scopeKey: `thread/${SCOPE_THREAD}`,
  })) as { id: string } | null;
  assert.equal(afterDismiss, null);
});
