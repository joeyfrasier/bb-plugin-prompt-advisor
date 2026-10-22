import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  owners,
  settledOwner,
  draftContentIdentity,
  beginPickerTransaction,
  isPickerTransaction,
  finishPickerTransaction,
  type ComposerOwner,
} from "../lib/composer-owner";
import type {
  PluginComposerApi,
  ComposerSelection,
} from "@get-bb/plugin-sdk/app";
const owner = (projectId: string): ComposerOwner => ({
  composer: {
    scope: { kind: "new-thread", projectId },
    selection: { projectId, providerId: "codex", model: "sol" },
    setInputLock: () => {},
  } as unknown as PluginComposerApi,
  setUndo: () => {},
  setApplying: () => {},
  setError: () => {},
  clearReview: () => {},
  suppressAutomatic: () => {},
});
afterEach(() => {
  finishPickerTransaction();
  owners.clear();
});
test("continues on a settled destination after the source slot remounts", () => {
  const original = owner("old");
  owners.set("old", original);
  beginPickerTransaction("new");
  owners.delete("old");
  const destination = owner("new");
  owners.set("new", destination);
  assert.equal(
    settledOwner(destination.composer.selection, original),
    destination,
  );
  assert.equal(isPickerTransaction("new"), true);
  finishPickerTransaction();
  assert.equal(isPickerTransaction("new"), false);
});
test("never selects an unrelated or ambiguous destination composer", () => {
  const unrelated = owner("other");
  owners.set("other", unrelated);
  assert.throws(
    () => settledOwner({ projectId: "new", providerId: "codex", model: "sol" }),
    /unavailable/,
  );
  const a = owner("new"),
    b = owner("new");
  owners.set("a", a);
  owners.set("b", b);
  assert.throws(() => settledOwner(a.composer.selection), /ambiguous/);
});
test("same-name same-size file replacement is a changed draft", () => {
  const before = {
    text: "Review this",
    mentions: [],
    attachments: [
      {
        type: "localFile" as const,
        path: "old-id/report.pdf",
        name: "report.pdf",
        sizeBytes: 1000,
      },
    ],
  };
  const replacement = {
    ...before,
    attachments: [{ ...before.attachments[0]!, path: "new-id/report.pdf" }],
  };
  assert.notEqual(
    draftContentIdentity(before),
    draftContentIdentity(replacement),
  );
  assert.notEqual(
    draftContentIdentity(before),
    draftContentIdentity({ ...before, text: "Added a new request" }),
  );
});

test("a matching project and model on a different machine is not the settled owner", () => {
  const current = owner("new");
  Object.assign(current.composer, {
    selection: {
      projectId: "new",
      providerId: "codex",
      model: "sol",
      environment: {
        type: "host",
        hostId: "wrong",
        workspace: { type: "personal" },
      },
    },
  });
  owners.set("new", current);
  assert.throws(
    () =>
      settledOwner({
        ...current.composer.selection,
        environment: {
          type: "host",
          hostId: "approved",
          workspace: { type: "personal" },
        },
      }),
    /unavailable/,
  );
});
