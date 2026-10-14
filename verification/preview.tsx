import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import app, { draftFingerprint, selectionSnapshot } from "../app";
const selection = {
  projectId: "demo",
  environment: {
    type: "host" as const,
    hostId: "dev",
    workspace: { type: "unmanaged" as const, path: "/demo" },
  },
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "max" as const,
  serviceTier: "default",
};
const text =
  "Improve the README.md introduction and fix its typo. Keep the existing facts.";
const model = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  label: "Sol 6.1",
  description: "General coding",
  reasoningLevels: ["low", "medium", "max"],
  serviceTiers: ["default", "ultrafast"],
};
const target = {
  id: "demo:dev",
  projectId: "demo",
  projectName: "Documentation",
  hostId: "dev",
  machineName: "Development box",
  platform: "linux",
  models: [model],
};
const run = {
  id: "demo-review",
  scopeKey: "demo",
  fingerprint: draftFingerprint(
    { text, mentions: [], attachments: [] },
    selection,
  ),
  original: text,
  selection: selectionSnapshot(selection),
  resolvedSelection: selectionSnapshot(selection),
  status: "done",
  review: {
    prompt:
      "Improve the introduction in README.md and fix its typo while preserving the existing facts.",
    summary:
      "Made the requested edits explicit. Maximum reasoning is more than this bounded documentation edit needs.",
    questions: [],
    recommendations: [
      {
        field: "reasoningLevel",
        value: "low",
        reason:
          "This is a small edit with a clear constraint. Low reasoning is sufficient; keep Sol 6.1 and the current machine.",
        confidence: 0.95,
      },
    ],
  },
  catalog: { targets: [target], warnings: [] },
  error: null,
  createdAt: Date.now(),
  deadline: Date.now() + 180000,
};
const loaded = await loadPluginApp(async () => app);
const slot = renderSlot(
  loaded.composerCustomizations[0]!.banners![0]!,
  {},
  {
    settings: { autoReview: false },
    pluginId: "prompt-advisor",
    composer: {
      scope: { kind: "new-thread", projectId: "demo" },
      text,
      selection,
    },
    rpc: {
      resume: () => run,
      startReview: () => run,
      dismiss: () => null,
      validateSettings: () => ({
        selection: { ...selectionSnapshot(selection), reasoningLevel: "low" },
        target,
      }),
    },
  },
);
slot.container.dataset.bbPlugin = "prompt-advisor";
slot.container.className = "bb-plugin-prompt-advisor preview-review";
const source = document.createElement("div");
source.className = "source-draft";
source.textContent = `Original draft: ${text}`;
document.body.append(source);
const note = document.createElement("p");
note.className = "fixture-note";
note.textContent =
  "Synthetic preview. Controls exercise the real plugin component; no task is started.";
document.body.prepend(note);
