// Renders the real review banner with synthetic data for visual checks. No task is started.
// Select a state with ?state=idle|unfinished|pending|ready|answered|good|applied.
import { act, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import app, { draftFingerprint, selectionSnapshot } from "../app";

const state = new URLSearchParams(location.search).get("state") ?? "ready";
const selection = {
  projectId: "demo",
  environment: {
    type: "host" as const,
    hostId: "dev",
    workspace: { type: "unmanaged" as const, path: "/demo" },
  },
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "medium" as const,
  serviceTier: "default",
};
const finished =
  "Openclaw enhancement request. Right now, openclaw creates a number of same named threads from Slack threads. It is hard to understand when these are created, what each is for, when they should be archived, etc.\n\nI'd like you to read the documentation, the source and also examine the existing channels that exist and try to identify how we can improve the naming and management of these channels.";
const text =
  state === "unfinished"
    ? "Openclaw enhancement request. Right now, openclaw creates a number of"
    : finished;
const model = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  label: "Sol 6.1",
  description: "General coding",
  reasoningLevels: ["low", "medium", "high", "max"],
  serviceTiers: ["default", "ultrafast"],
};
const target = {
  id: "demo:dev",
  projectId: "demo",
  projectName: "Openclaw",
  hostId: "dev",
  machineName: "VPS",
  platform: "linux",
  models: [model],
};
const rewritten =
  "I want to understand and improve how Openclaw names and manages the threads it creates from Slack threads. It currently creates multiple threads with the same name, making it hard to tell when they are created, what each is for, and when they should be archived.\n\n1. Read the relevant documentation and source, and examine the existing threads and channels involved. Explain how creation, naming, and archiving currently work.\n2. Recommend improvements that make each thread’s purpose clear and make naming and lifecycle management easier to understand.\n\nPlease return your findings and recommendations. Investigate only; don’t change code, rename anything, or archive anything yet.";
const review =
  state === "good"
    ? { prompt: text, changes: [], questions: [], recommendations: [] }
    : {
        prompt: rewritten,
        changes: [
          "Put the goal and duplicate-name problem first",
          "Split investigation and recommendations into distinct requests",
          "Made the read-only scope explicit",
        ],
        questions:
          state === "answered"
            ? []
            : [
                {
                  question:
                    "When you say “channels,” which objects do you want examined and improved?",
                  options: [
                    "Openclaw threads or sessions",
                    "Slack channels and threads",
                    "Both",
                  ],
                },
              ],
        recommendations: [
          {
            field: "reasoningLevel",
            value: "high",
            reason:
              "Reading source and live channels needs tools, so high reasoning is the minimum.",
            confidence: 0.92,
          },
        ],
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
  status: state === "pending" ? "pending" : "done",
  review: state === "pending" ? null : review,
  catalog: { targets: [target], warnings: [] },
  answers:
    state === "answered"
      ? [{ question: "Which channels?", answer: "Both" }]
      : null,
  error: null,
  createdAt: Date.now(),
  deadline: Date.now() + 180000,
};
const idle = state === "idle" || state === "unfinished";
const loaded = await loadPluginApp(async () => app);
const slot = renderSlot(
  loaded.composerCustomizations[0]!.banners![0]!,
  {},
  {
    settings: { autoReview: true, debounceMs: 60000 },
    pluginId: "prompt-advisor",
    composer: {
      scope: { kind: "new-thread", projectId: "demo" },
      text,
      selection,
    },
    rpc: {
      resume: () => (idle ? null : run),
      startReview: () => run,
      getReview: () => run,
      dismiss: () => null,
      validateSettings: () => ({
        selection: { ...selectionSnapshot(selection), reasoningLevel: "high" },
        target,
      }),
    },
  },
);
slot.container.dataset.bbPlugin = "prompt-advisor";
slot.container.className = "bb-plugin-prompt-advisor preview-review";
if (state === "applied") {
  const apply = await slot.findByRole("button", { name: "Apply" });
  await act(async () => fireEvent.click(apply));
}
const composer = document.createElement("div");
composer.className = "source-draft";
composer.textContent = text;
document.body.append(composer);
