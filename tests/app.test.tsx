// Must precede React: it detects DOM input events when it first loads.
import "./dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import app, {
  selectionSnapshot,
  draftFingerprint,
  requestReview,
} from "../app";

const selection = {
  projectId: "p1",
  environment: {
    type: "host" as const,
    hostId: "h1",
    workspace: { type: "unmanaged" as const, path: "/app" },
  },
  providerId: "codex",
  model: "sol",
  reasoningLevel: "high" as const,
  serviceTier: "default",
};
const normalized = selectionSnapshot(selection);
const original = "Fix src/a.ts.";
const model = {
  providerId: "codex",
  model: "sol",
  label: "Sol",
  description: "Coding",
  reasoningLevels: ["low", "high"],
  serviceTiers: ["default"],
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
  ],
  warnings: [],
};
const loaded = await loadPluginApp(async () => app);
const banner = loaded.composerCustomizations[0]!.banners![0]!;
const firstRun = {
  id: "r1",
  scopeKey: "new-thread:p1",
  fingerprint: draftFingerprint(
    { text: original, mentions: [], attachments: [] },
    selection,
  ),
  original,
  selection: normalized,
  resolvedSelection: normalized,
  status: "done",
  review: {
    prompt: "Please fix src/a.ts.",
    changes: ["Made the request clear."],
    questions: [],
    recommendations: [
      {
        field: "reasoningLevel",
        value: "low",
        reason: "A bounded edit needs less effort.",
        confidence: 0.95,
      },
    ],
  },
  catalog,
  error: null,
  createdAt: Date.now(),
  deadline: Date.now() + 10000,
};
function mount(resume: () => unknown = () => firstRun) {
  return renderSlot(
    banner,
    {},
    {
      settings: { autoReview: false },
      composer: {
        scope: { kind: "new-thread", projectId: "p1" },
        text: original,
        selection,
      },
      rpc: {
        resume,
        startReview: () => firstRun,
        dismiss: () => null,
        validateSettings: () => ({
          selection: { ...normalized, reasoningLevel: "low" },
          target: catalog.targets[0],
        }),
      },
    },
  );
}

test("review is registered only for the first prompt in a new thread", () => {
  assert.deepEqual(loaded.composerCustomizations[0]!.scopes, ["new-thread"]);
});
test("selected prompt and effort apply together and undo restores the original", async () => {
  const slot = mount();
  try {
    await slot.findByRole("checkbox", { name: "Rewritten prompt" });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply" }));
    });
    await waitFor(() =>
      assert.equal(slot.inspection.composer.text, "Please fix src/a.ts."),
    );
    assert.equal(slot.inspection.composer.selection?.reasoningLevel, "low");
    assert.equal(slot.inspection.composer.submits.length, 0);
    assert.equal(slot.inspection.composer.inputLocked, false);
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Undo" }));
    });
    assert.equal(slot.inspection.composer.text, original);
    assert.equal(slot.inspection.composer.selection?.reasoningLevel, "high");
  } finally {
    slot.lifecycle.unmount();
  }
});
test("deselecting effort leaves the current model settings intact", async () => {
  const slot = mount();
  try {
    await slot.findByRole("checkbox", { name: "Rewritten prompt" });
    fireEvent.click(slot.getByRole("checkbox", { name: /Reasoning/ }));
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply" }));
    });
    await waitFor(() =>
      assert.equal(slot.inspection.composer.text, "Please fix src/a.ts."),
    );
    assert.equal(slot.inspection.composer.selection?.reasoningLevel, "high");
    assert.equal(
      slot.inspection.rpcCalls.filter((c) => c.method === "validateSettings")
        .length,
      0,
    );
  } finally {
    slot.lifecycle.unmount();
  }
});
test("editing a draft while a resumed result arrives prevents stale application", async () => {
  let resolve!: (v: unknown) => void;
  const slot = mount(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  try {
    await slot.behavior.setComposerText("Fix src/b.ts");
    await act(async () => resolve(firstRun));
    assert.equal(slot.inspection.composer.text, "Fix src/b.ts");
    assert.equal(slot.queryByText("Please fix src/a.ts."), null);
    assert.ok(slot.inspection.rpcCalls.some((c) => c.method === "dismiss"));
  } finally {
    slot.lifecycle.unmount();
  }
});
test("explicit start sends exactly once with the reviewed settings", async () => {
  const slot = mount();
  try {
    await slot.findByRole("checkbox", { name: "Rewritten prompt" });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply & start" }));
    });
    await waitFor(() =>
      assert.equal(slot.inspection.composer.submits.length, 1),
    );
    assert.equal(slot.inspection.composer.selection?.reasoningLevel, "low");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("cancelling the initial request rejects its late result", async () => {
  let finish!: (result: unknown) => void;
  const slot = renderSlot(
    banner,
    {},
    {
      settings: { autoReview: false },
      composer: {
        scope: { kind: "new-thread", projectId: "p1" },
        text: original,
        selection,
      },
      rpc: {
        resume: () => null,
        startReview: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        dismiss: () => null,
      },
    },
  );
  try {
    fireEvent.click(slot.getByRole("button", { name: /Review now/ }));
    await slot.findByRole("button", { name: "Cancel" });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    });
    await act(async () => {
      finish(firstRun);
    });
    assert.equal(slot.queryByText("Please fix src/a.ts."), null);
    assert.equal(slot.inspection.composer.text, original);
    assert.ok(
      slot.inspection.rpcCalls.some((call) => call.method === "dismiss"),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("target migration preserves unselected execution settings", async () => {
  const destination = {
    ...catalog.targets[0]!,
    id: "p2:h2",
    projectId: "p2",
    hostId: "h2",
    path: "/destination",
  };
  const advised = {
    ...firstRun,
    catalog: { targets: [...catalog.targets, destination], warnings: [] },
    review: {
      ...firstRun.review,
      recommendations: [
        {
          field: "target",
          value: "p2:h2",
          reason: "The task belongs to this project.",
          confidence: 0.95,
        },
      ],
    },
  };
  const slot = renderSlot(
    banner,
    {},
    {
      settings: { autoReview: false },
      composer: {
        scope: { kind: "new-thread", projectId: "p1" },
        text: original,
        selection,
      },
      rpc: {
        resume: () => advised,
        dismiss: () => null,
        validateSettings: () => ({
          selection: { ...normalized, projectId: "p2", hostId: "h2" },
          target: destination,
        }),
      },
    },
  );
  try {
    await slot.findByRole("checkbox", { name: "Rewritten prompt" });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply" }));
    });
    await waitFor(() =>
      assert.equal(slot.inspection.composer.text, "Please fix src/a.ts."),
    );
    assert.equal(slot.inspection.composer.selection?.projectId, "p2");
    assert.equal(slot.inspection.composer.selection?.model, "sol");
    assert.equal(slot.inspection.composer.selection?.reasoningLevel, "high");
    assert.equal(slot.inspection.composer.selection?.serviceTier, "default");
    const patch = slot.inspection.composer.selections[0]!;
    assert.equal(patch.model, "sol");
    assert.equal(patch.reasoningLevel, "high");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("acknowledgement failure keeps applied changes and Undo", async () => {
  const slot = renderSlot(
    banner,
    {},
    {
      settings: { autoReview: false },
      composer: {
        scope: { kind: "new-thread", projectId: "p1" },
        text: original,
        selection,
      },
      rpc: {
        resume: () => firstRun,
        dismiss: () => {
          throw new Error("offline");
        },
        validateSettings: () => ({
          selection: { ...normalized, reasoningLevel: "low" },
          target: catalog.targets[0],
        }),
      },
    },
  );
  try {
    await slot.findByRole("checkbox", { name: "Rewritten prompt" });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply" }));
    });
    await slot.findByRole("button", { name: "Undo" });
    assert.equal(slot.inspection.composer.text, "Please fix src/a.ts.");
    assert.equal(slot.inspection.composer.selection?.reasoningLevel, "low");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("automatic review waits for the configured pause and stays suppressed after Apply and Undo", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const slot = renderSlot(
    banner,
    {},
    {
      settings: { autoReview: true, debounceMs: 2500 },
      composer: {
        scope: { kind: "new-thread", projectId: "p1" },
        text: original,
        selection,
      },
      rpc: {
        resume: () => null,
        startReview: () => firstRun,
        dismiss: () => null,
        validateSettings: () => ({
          selection: { ...normalized, reasoningLevel: "low" },
          target: catalog.targets[0],
        }),
      },
    },
  );
  const starts = () =>
    slot.inspection.rpcCalls.filter((c) => c.method === "startReview").length;
  try {
    await act(async () => {
      t.mock.timers.tick(2499);
    });
    assert.equal(starts(), 0);
    await act(async () => {
      t.mock.timers.tick(1);
    });
    assert.equal(starts(), 1);
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply" }));
    });
    assert.equal(slot.inspection.composer.text, "Please fix src/a.ts.");
    await act(async () => {
      t.mock.timers.tick(60000);
    });
    assert.equal(starts(), 1);
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Undo" }));
    });
    await act(async () => {
      t.mock.timers.tick(60000);
    });
    assert.equal(slot.inspection.composer.text, original);
    assert.equal(starts(), 1);
  } finally {
    slot.lifecycle.unmount();
    t.mock.timers.reset();
  }
});

function autoSlot(
  text: string,
  settings: Record<string, string | number | boolean>,
) {
  return renderSlot(
    banner,
    {},
    {
      settings,
      composer: {
        scope: { kind: "new-thread", projectId: "p1" },
        text,
        selection,
      },
      rpc: {
        resume: () => null,
        startReview: () => ({ ...firstRun, status: "pending", review: null }),
        getReview: () => null,
        dismiss: () => null,
      },
    },
  );
}

test("automatic review defaults to a one-minute pause and skips unfinished sentences", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const slot = autoSlot("Fix src/a.ts and", { autoReview: true });
  const starts = () =>
    slot.inspection.rpcCalls.filter((c) => c.method === "startReview").length;
  try {
    await act(async () => {
      t.mock.timers.tick(10 * 60000);
    });
    assert.equal(starts(), 0, "an unfinished sentence is never auto-reviewed");
    assert.ok(
      slot.getByText("Automatic review waits for a finished sentence."),
    );
    await slot.behavior.setComposerText(original);
    await act(async () => {
      t.mock.timers.tick(59999);
    });
    assert.equal(starts(), 0, "no review before a full minute without typing");
    await act(async () => {
      t.mock.timers.tick(1);
    });
    assert.equal(starts(), 1);
  } finally {
    slot.lifecycle.unmount();
    t.mock.timers.reset();
  }
});

test("typing restarts the pause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const slot = autoSlot(original, { autoReview: true });
  const starts = () =>
    slot.inspection.rpcCalls.filter((c) => c.method === "startReview").length;
  try {
    await act(async () => {
      t.mock.timers.tick(50000);
    });
    await slot.behavior.setComposerText("Fix src/a.ts. Keep it small.");
    await act(async () => {
      t.mock.timers.tick(50000);
    });
    assert.equal(starts(), 0);
    await act(async () => {
      t.mock.timers.tick(10000);
    });
    assert.equal(starts(), 1);
  } finally {
    slot.lifecycle.unmount();
    t.mock.timers.reset();
  }
});

test("the review shortcut is a rebindable composer command that reviews unfinished drafts", async () => {
  // The harness collects commands but does not declare them on its result type.
  type Command = {
    id: string;
    target: string;
    defaultShortcut: Record<string, unknown>;
    run(context: { composer: unknown }): Promise<void> | void;
  };
  const command = (
    loaded as unknown as { commandPaletteActions: Command[] }
  ).commandPaletteActions.find((c) => c.id === "review-prompt")!;
  assert.equal(command.target, "composer");
  assert.deepEqual(
    { ...command.defaultShortcut },
    {
      key: "r",
      mod: true,
      shift: true,
      meta: false,
      control: false,
      alt: false,
    },
  );
  const slot = autoSlot("Fix src/a.ts and", { autoReview: true });
  try {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail.key);
    window.addEventListener("prompt-advisor:review", listener);
    await command.run({
      composer: {
        key: slot.inspection.composer.key,
        isEmpty: false,
        scope: { kind: "new-thread", projectId: "p1" },
      },
    });
    await command.run({
      composer: {
        key: "thread",
        isEmpty: false,
        scope: { kind: "thread", threadId: "t1" },
      },
    });
    window.removeEventListener("prompt-advisor:review", listener);
    assert.deepEqual(seen, [slot.inspection.composer.key]);
    await waitFor(() =>
      assert.equal(
        slot.inspection.rpcCalls.filter((c) => c.method === "startReview")
          .length,
        1,
      ),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("only proposed changes show by default; the explanation is collapsed", async () => {
  const slot = mount(() => ({
    ...firstRun,
    review: { ...firstRun.review, summary: "Long prose explanation." },
  }));
  try {
    await slot.findByRole("checkbox", { name: "Rewritten prompt" });
    assert.ok(slot.getByText("Please fix src/a.ts."));
    assert.ok(slot.getByText("high →", { exact: false }));
    const details = slot.getByText("Why these changes").closest("details")!;
    assert.equal(details.open, false);
    assert.ok(details.textContent!.includes("Long prose explanation."));
    assert.ok(
      details.textContent!.includes("A bounded edit needs less effort."),
    );
    fireEvent.click(slot.getByRole("button", { name: "Show changes" }));
    const region = slot.getByLabelText(
      "Changes from your draft to the rewritten prompt",
    );
    assert.deepEqual(
      [...region.querySelectorAll("ins")].map((n) => n.textContent),
      ["Please fix"],
    );
    assert.deepEqual(
      [...region.querySelectorAll("del")].map((n) => n.textContent),
      ["Fix"],
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("answering a question re-runs the review with the answers folded in", async () => {
  const asked = {
    ...firstRun,
    review: {
      ...firstRun.review,
      recommendations: [],
      questions: [
        {
          question: "Which channels: Slack, BB threads, or both?",
          options: ["Slack channels", "BB threads", "Both"],
        },
        { question: "Any deadline?", options: [] },
      ],
    },
  };
  const slot = mount(() => asked);
  try {
    await slot.findByText("Which channels: Slack, BB threads, or both?");
    const update = slot.getByRole("button", {
      name: "Update prompt with answer",
    }) as HTMLButtonElement;
    assert.equal(update.disabled, true);
    fireEvent.click(slot.getByRole("button", { name: "Both" }));
    assert.equal(
      slot.getByRole("button", { name: "Both" }).getAttribute("aria-pressed"),
      "true",
    );
    await act(async () => {
      fireEvent.click(update);
    });
    const call = slot.inspection.rpcCalls.find(
      (c) => c.method === "startReview",
    )!;
    const input = call.input as {
      refineFrom: string;
      answers: unknown;
      text: string;
    };
    assert.equal(input.refineFrom, "r1");
    assert.equal(input.text, original);
    assert.deepEqual(input.answers, [
      {
        question: "Which channels: Slack, BB threads, or both?",
        answer: "Both",
      },
    ]);
    assert.equal(slot.inspection.composer.text, original);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a free-text answer submits with Enter", async () => {
  const slot = mount(() => ({
    ...firstRun,
    review: {
      ...firstRun.review,
      questions: [{ question: "Any deadline?", options: [] }],
    },
  }));
  try {
    const field = await slot.findByRole("textbox", { name: "Any deadline?" });
    fireEvent.change(field, { target: { value: "Friday" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    const call = slot.inspection.rpcCalls.find(
      (c) => c.method === "startReview",
    )!;
    assert.deepEqual((call.input as { answers: unknown }).answers, [
      { question: "Any deadline?", answer: "Friday" },
    ]);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("requestReview targets only the matching composer", async () => {
  const slot = autoSlot(original, { autoReview: false });
  try {
    await act(async () => requestReview("someone-else"));
    assert.equal(
      slot.inspection.rpcCalls.filter((c) => c.method === "startReview").length,
      0,
    );
  } finally {
    slot.lifecycle.unmount();
  }
});
