import type {
  ComposerDraftSnapshot,
  ComposerSelection,
  PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
export interface UndoSnapshot {
  draft: ComposerDraftSnapshot;
  selection: ComposerSelection | null;
  after: string;
}
export interface ComposerOwner {
  composer: PluginComposerApi;
  setUndo: (value: UndoSnapshot | null) => void;
  setApplying: (value: boolean) => void;
  setError: (value: string | null) => void;
  clearReview: () => void;
  suppressAutomatic: (fingerprint: string) => void;
}
export const owners = new Map<string, ComposerOwner>();
let pendingProject: string | null | undefined;
export function beginPickerTransaction(projectId: string | null) {
  pendingProject = projectId;
}
export function isPickerTransaction(projectId: string | undefined) {
  return pendingProject !== undefined && pendingProject === (projectId ?? null);
}
export function finishPickerTransaction() {
  pendingProject = undefined;
  for (const owner of owners.values()) {
    owner.composer.setInputLock(false);
    owner.setApplying(false);
  }
}
/** A project switch remounts the slot. Continue on the active, settled destination composer. */
export function settledOwner(
  selection: ComposerSelection | null,
  preferred?: ComposerOwner,
): ComposerOwner {
  const matches = [...owners.values()].filter((owner) => {
    const current = owner.composer.selection;
    return (
      owner.composer.scope.kind === "new-thread" &&
      [
        "projectId",
        "providerId",
        "model",
        "reasoningLevel",
        "serviceTier",
        "permissionMode",
      ].every(
        (field) =>
          current?.[field as keyof ComposerSelection] ===
          selection?.[field as keyof ComposerSelection],
      ) &&
      JSON.stringify(current?.environment) ===
        JSON.stringify(selection?.environment)
    );
  });
  if (preferred && matches.includes(preferred)) return preferred;
  if (matches.length !== 1)
    throw new Error(
      "The destination composer is unavailable or ambiguous. Check its draft and settings.",
    );
  return matches[0]!;
}
/** Exact attachment identity is required: names and sizes do not identify a file. */
export function draftContentIdentity(draft: ComposerDraftSnapshot): string {
  return JSON.stringify(draft);
}
