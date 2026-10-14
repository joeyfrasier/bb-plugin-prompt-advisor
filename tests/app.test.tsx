import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import app, { selectionSnapshot, draftFingerprint } from "../app";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "CustomEvent",
  "MutationObserver",
] as const)
  Object.defineProperty(globalThis, name, {
    value: dom.window[name],
    configurable: true,
  });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  writable: true,
  configurable: true,
});
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
const original = "Fix src/a.ts";
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
    summary: "Made the request clear.",
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
    await slot.findByText("Made the request clear.");
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply selected" }));
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
    await slot.findByText("Made the request clear.");
    fireEvent.click(slot.getByRole("checkbox", { name: /Reasoning: low/ }));
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply selected" }));
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
    assert.equal(slot.queryByText("Made the request clear."), null);
    assert.ok(slot.inspection.rpcCalls.some((c) => c.method === "dismiss"));
  } finally {
    slot.lifecycle.unmount();
  }
});
test("explicit start sends exactly once with the reviewed settings", async () => {
  const slot = mount();
  try {
    await slot.findByText("Made the request clear.");
    await act(async () => {
      fireEvent.click(
        slot.getByRole("button", { name: "Apply selected & start" }),
      );
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
    fireEvent.click(slot.getByRole("button", { name: "Review now" }));
    await slot.findByRole("button", { name: "Cancel review" });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Cancel review" }));
    });
    await act(async () => {
      finish(firstRun);
    });
    assert.equal(slot.queryByText("Made the request clear."), null);
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
    await slot.findByText("Made the request clear.");
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply selected" }));
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
    await slot.findByText("Made the request clear.");
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply selected" }));
    });
    await slot.findByRole("button", { name: "Undo" });
    assert.equal(slot.inspection.composer.text, "Please fix src/a.ts.");
    assert.equal(slot.inspection.composer.selection?.reasoningLevel, "low");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("automatic review waits for the typing pause and stays suppressed after Apply and Undo", async (t) => {
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
      fireEvent.click(slot.getByRole("button", { name: "Apply selected" }));
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
