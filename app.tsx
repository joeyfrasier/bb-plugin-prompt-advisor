import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useComposer,
  useRpc,
  useSettings,
  type ComposerSelection,
  type ComposerDraftSnapshot,
} from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import {
  MIN_RECOMMENDATION_CONFIDENCE,
  reviewSelectionSchema,
  remapMentions,
  validateRecommendations,
  type Recommendation,
  type ReviewSelection,
} from "./lib/review";
import {
  owners,
  beginPickerTransaction,
  isPickerTransaction,
  finishPickerTransaction,
  settledOwner,
  draftContentIdentity,
  type ComposerOwner,
  type UndoSnapshot,
} from "./lib/composer-owner";
import { startSerialPoll } from "./lib/serial-poll";
import type { rpcContract } from "./server";

const REQUEST_REVIEW = "prompt-advisor:review";
// Inferred RPC result narrowed independently of method overloads.
type ReviewRun = import("zod").infer<typeof import("./server").runSchema>;

export function selectionSnapshot(
  selection: ComposerSelection | null,
): ReviewSelection {
  const environment = selection?.environment;
  return reviewSelectionSchema.parse({
    projectId: selection?.projectId ?? null,
    hostId:
      environment?.type === "host"
        ? (environment.hostId ?? null)
        : environment?.type === "provider" &&
            environment.machine?.type === "existing"
          ? environment.machine.hostId
          : null,
    environmentId:
      environment?.type === "reuse" ? environment.environmentId : null,
    providerId: selection?.providerId ?? null,
    model: selection?.model ?? null,
    reasoningLevel: selection?.reasoningLevel ?? null,
    serviceTier: selection?.serviceTier ?? null,
  });
}
export function draftFingerprint(
  draft: ComposerDraftSnapshot,
  selection: ComposerSelection | null,
): string {
  return JSON.stringify({
    text: draft.text,
    mentions: draft.mentions,
    attachments: draft.attachments,
    selection: selectionSnapshot(selection),
    pickerSelection: selection,
    environment: selection?.environment ?? null,
  });
}
const labels: Record<Recommendation["field"], string> = {
  target: "Project and machine",
  model: "Model",
  reasoningLevel: "Reasoning",
  serviceTier: "Speed tier",
};

function ReviewBanner() {
  const composer = useComposer(),
    rpc = useRpc<typeof rpcContract>(),
    settings = useSettings();
  const [run, setRun] = useState<ReviewRun | null>(null);
  const [loading, setLoading] = useState(false),
    [applying, setApplying] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Recommendation["field"][]>([]),
    [usePrompt, setUsePrompt] = useState(true);
  const [undo, setUndo] = useState<{
    draft: ComposerDraftSnapshot;
    selection: ComposerSelection | null;
    after: string;
  } | null>(null);
  const attempted = useRef<string | null>(null),
    lastAutomatic = useRef(0),
    alive = useRef(true),
    starting = useRef(false),
    applyingRef = useRef(false),
    epoch = useRef(0);
  const fingerprint = draftFingerprint(composer.draft, composer.selection);
  const current = useRef(fingerprint);
  current.current = fingerprint;
  const key = composer.key;
  const ownerRef = useRef<ComposerOwner | null>(null);
  useEffect(() => {
    const owner: ComposerOwner = {
      composer,
      setUndo,
      setApplying,
      setError,
      clearReview: () => setRun(null),
      suppressAutomatic: (value) => {
        attempted.current = value;
      },
    };
    ownerRef.current = owner;
    owners.set(key, owner);
    if (isPickerTransaction(composer.selection?.projectId)) {
      setApplying(true);
      composer.setInputLock(true);
    }
    return () => {
      if (owners.get(key) === owner) owners.delete(key);
    };
  }, [key, composer]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, [key]);
  const adopt = useCallback((next: ReviewRun) => {
    setRun(next);
    setError(null);
    if (next.review && next.catalog) {
      const selected = next.review.recommendations
        .filter((rec) => rec.confidence >= MIN_RECOMMENDATION_CONFIDENCE)
        .map((rec) => rec.field);
      try {
        validateRecommendations(
          next.resolvedSelection ?? next.selection,
          next.review.recommendations.filter((r) => selected.includes(r.field)),
          next.catalog,
        );
        setFields(selected);
      } catch {
        setFields([]);
      }
      setUsePrompt(true);
    }
  }, []);

  const start = useCallback(async () => {
    if (
      starting.current ||
      applyingRef.current ||
      composer.isEmpty ||
      composer.isSubmitting
    )
      return;
    if (composer.text.length > 16000) {
      setError(
        "This draft is too long for review (16,000 characters). Shorten it or send it directly.",
      );
      return;
    }
    starting.current = true;
    setLoading(true);
    setError(null);
    setUndo(null);
    const requested = draftFingerprint(composer.draft, composer.selection),
      token = epoch.current;
    attempted.current = requested;
    try {
      const next = await rpc.call("startReview", {
        scopeKey: composer.key,
        fingerprint: requested,
        text: composer.text,
        selection: selectionSnapshot(composer.selection),
        mentionLabels: composer.draft.mentions.map((m) =>
          composer.text.slice(m.from, m.to),
        ),
        attachmentCount: composer.attachmentCount,
      });
      if (
        !alive.current ||
        epoch.current !== token ||
        current.current !== requested
      ) {
        void rpc.call("dismiss", { id: next.id }).catch(() => {});
        return;
      }
      adopt(next);
    } catch {
      if (alive.current && epoch.current === token)
        setError(
          "Review could not start. Check the project and machine selection, then retry.",
        );
    } finally {
      starting.current = false;
      if (alive.current) setLoading(false);
    }
  }, [composer, rpc, adopt]);

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("resume", { scopeKey: key })
      .then((next) => {
        if (cancelled || !next || starting.current) return;
        if (next.fingerprint === current.current) {
          attempted.current = next.fingerprint;
          adopt(next);
        } else void rpc.call("dismiss", { id: next.id }).catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rpc, key, adopt]);

  useEffect(() => {
    if (!run || run.status !== "pending") return;
    return startSerialPoll(async (stopped) => {
      try {
        const next = await rpc.call("getReview", { id: run.id });
        if (!stopped() && next) {
          if (next.fingerprint === current.current) adopt(next);
          else {
            void rpc.call("dismiss", { id: next.id }).catch(() => {});
            setRun(null);
          }
        }
      } catch {
        if (!stopped())
          setError(
            "Review connection was interrupted. Retry or keep your original prompt.",
          );
      }
    }, 2000);
  }, [run?.id, run?.status, rpc, adopt]);

  useEffect(() => {
    if (run && run.fingerprint !== fingerprint && !applyingRef.current) {
      void rpc.call("dismiss", { id: run.id }).catch(() => {});
      setRun(null);
    }
    if (
      settings.isLoading ||
      settings.values?.autoReview !== true ||
      composer.isEmpty ||
      composer.isSubmitting ||
      fingerprint === attempted.current ||
      applyingRef.current ||
      isPickerTransaction(composer.selection?.projectId) ||
      undo
    )
      return;
    const pause =
      typeof settings.values?.debounceMs === "number"
        ? settings.values?.debounceMs
        : 2500;
    const delay = Math.max(pause, 15000 - (Date.now() - lastAutomatic.current));
    const timer = setTimeout(() => {
      lastAutomatic.current = Date.now();
      void start();
    }, delay);
    return () => clearTimeout(timer);
  }, [
    fingerprint,
    settings.isLoading,
    settings.values?.autoReview,
    settings.values?.debounceMs,
    composer.isEmpty,
    composer.isSubmitting,
    start,
    run?.id,
    undo,
  ]);

  useEffect(
    () =>
      composer.onSubmitted(() => {
        epoch.current++;
        attempted.current = null;
        setUndo(null);
        setRun(null);
        setError(null);
        if (run) void rpc.call("dismiss", { id: run.id }).catch(() => {});
      }),
    [composer, rpc, run?.id],
  );
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent).detail?.key === key) void start();
    };
    window.addEventListener(REQUEST_REVIEW, listener);
    return () => window.removeEventListener(REQUEST_REVIEW, listener);
  }, [key, start]);

  async function dismiss() {
    epoch.current++;
    setLoading(false);
    attempted.current = fingerprint;
    setRun(null);
    setError(null);
    if (run) await rpc.call("dismiss", { id: run.id }).catch(() => {});
  }
  function settingLabel(rec: Recommendation): string {
    if (rec.field === "target") {
      const target = run?.catalog?.targets.find((t) => t.id === rec.value);
      return target
        ? `${target.projectName} · ${target.machineName}`
        : rec.value;
    }
    if (rec.field === "model")
      return (
        run?.catalog?.targets
          .flatMap((t) => t.models)
          .find((m) => m.model === rec.value && m.providerId === rec.providerId)
          ?.label ?? rec.value
      );
    return rec.value;
  }
  async function apply(send: boolean) {
    if (
      !run?.review ||
      current.current !== run.fingerprint ||
      applyingRef.current
    )
      return;
    const beforeDraft = composer.draft,
      beforeSelection = composer.selection,
      token = epoch.current;
    applyingRef.current = true;
    setApplying(true);
    setError(null);
    composer.setInputLock(true);
    const targetProject = run.review.recommendations.find(
      (r) => fields.includes("target") && r.field === "target",
    );
    const destination = targetProject
      ? run.catalog?.targets.find((t) => t.id === targetProject.value)
          ?.projectId
      : beforeSelection?.projectId;
    beginPickerTransaction(destination ?? null);
    let activeOwner = ownerRef.current!;
    let contentApplied = false;
    try {
      const mentions = usePrompt
        ? remapMentions(
            beforeDraft.text,
            run.review.prompt,
            beforeDraft.mentions,
          )
        : beforeDraft.mentions;
      if (fields.length) {
        const validated = await rpc.call("validateSettings", {
          id: run.id,
          fields,
          selection: selectionSnapshot(beforeSelection),
        });
        if (
          !alive.current ||
          epoch.current !== token ||
          JSON.stringify(composer.selection) !==
            JSON.stringify(beforeSelection) ||
          JSON.stringify(composer.draft) !== JSON.stringify(beforeDraft)
        )
          throw new Error("The draft changed. Review it again.");
        const proposed: ComposerSelection = fields.includes("target")
          ? {
              providerId: validated.selection.providerId ?? undefined,
              model: validated.selection.model ?? undefined,
              reasoningLevel: validated.selection.reasoningLevel ?? undefined,
              serviceTier: validated.selection.serviceTier ?? undefined,
              permissionMode: beforeSelection?.permissionMode,
            }
          : {};
        if (fields.includes("target") && validated.target) {
          const t = validated.target;
          if (beforeDraft.attachments.length > 0)
            throw new Error(
              "This draft has attachments. Change the project or machine manually and review again so its attachments can be revalidated.",
            );
          if (
            beforeDraft.attachments.some(
              (a) => a.hostId && a.hostId !== t.hostId,
            )
          )
            throw new Error(
              "A machine-local attachment belongs to another machine. Keep that machine or reattach the file.",
            );
          // Workspace and thread-storage pills cannot safely migrate to a different checkout.
          if (
            beforeDraft.mentions.some(
              (m) =>
                m.kind === "path" ||
                m.kind === "attachment" ||
                (m.kind === "command" && m.origin === "project"),
            )
          )
            throw new Error(
              "This draft contains workspace references. Keep this project and machine or edit those references first.",
            );
          proposed.projectId = t.projectId;
          const previousWorkspace =
            beforeSelection?.environment?.type === "host"
              ? beforeSelection.environment.workspace
              : null;
          proposed.environment = {
            type: "host",
            hostId: t.hostId,
            workspace: t.personal
              ? { type: "personal" }
              : previousWorkspace?.type === "managed-worktree"
                ? { ...previousWorkspace, baseBranch: { kind: "default" } }
                : { type: "unmanaged", path: t.path ?? null },
          };
        }
        if (fields.includes("model")) {
          proposed.providerId = validated.selection.providerId ?? undefined;
          proposed.model = validated.selection.model ?? undefined;
          proposed.reasoningLevel =
            validated.selection.reasoningLevel ?? undefined;
          proposed.serviceTier = validated.selection.serviceTier ?? undefined;
        }
        if (fields.includes("reasoningLevel"))
          proposed.reasoningLevel =
            validated.selection.reasoningLevel ?? undefined;
        if (fields.includes("serviceTier"))
          proposed.serviceTier = validated.selection.serviceTier ?? undefined;
        const settled = await composer.setSelection(proposed);
        activeOwner = settledOwner(settled, activeOwner);
        activeOwner.setApplying(true);
        activeOwner.composer.setInputLock(true);
        for (const field of [
          "projectId",
          "providerId",
          "model",
          "reasoningLevel",
          "serviceTier",
          "permissionMode",
        ] as const)
          if (
            proposed[field] !== undefined &&
            settled[field] !== proposed[field]
          )
            throw new Error(
              "BB could not apply all recommended settings. Check the selectors.",
            );
        if (
          proposed.environment?.type === "host" &&
          selectionSnapshot(settled).hostId !== proposed.environment.hostId
        )
          throw new Error("BB could not select the recommended machine.");
      }
      const destinationComposer = activeOwner.composer;
      if (
        draftContentIdentity(destinationComposer.draft) !==
        draftContentIdentity(beforeDraft)
      )
        throw new Error("The draft changed. Review it again.");
      if (usePrompt)
        destinationComposer.replace((current) => {
          if (
            draftContentIdentity(current) !== draftContentIdentity(beforeDraft)
          )
            throw new Error("The draft changed. Review it again.");
          return { text: run.review!.prompt, mentions };
        });
      contentApplied = true;
      const after = draftFingerprint(
        destinationComposer.draft,
        destinationComposer.selection,
      );
      activeOwner.suppressAutomatic(after);
      activeOwner.clearReview();
      activeOwner.setUndo({
        draft: beforeDraft,
        selection: beforeSelection,
        after,
      });
      // Acknowledgement is housekeeping: a failed connection must not roll back applied changes or lose Undo.
      void rpc.call("dismiss", { id: run.id }).catch(() => {});
      if (send) {
        destinationComposer.setInputLock(false);
        await destinationComposer.submit({
          experimental_data: { reviewId: run.id, reviewed: true },
        });
      }
    } catch (e) {
      if (!contentApplied && beforeSelection) {
        try {
          const restored =
            await activeOwner.composer.setSelection(beforeSelection);
          activeOwner = settledOwner(restored, activeOwner);
        } catch {
          /* Preserve the draft and report the current selectors. */
        }
      }
      activeOwner.setError(
        e instanceof Error
          ? e.message
          : "Could not apply the review. Your draft is preserved.",
      );
    } finally {
      applyingRef.current = false;
      finishPickerTransaction();
    }
  }
  async function restore() {
    if (
      !undo ||
      draftFingerprint(composer.draft, composer.selection) !== undo.after
    ) {
      setError(
        "The draft or settings changed after applying. Undo would overwrite your edits.",
      );
      return;
    }
    const expected = draftContentIdentity(composer.draft);
    beginPickerTransaction(undo.selection?.projectId ?? null);
    let activeOwner = ownerRef.current!;
    activeOwner.setApplying(true);
    composer.setInputLock(true);
    try {
      if (undo.selection) {
        const settled = await composer.setSelection(undo.selection);
        for (const field of [
          "projectId",
          "providerId",
          "model",
          "reasoningLevel",
          "serviceTier",
          "permissionMode",
        ] as const) {
          if (
            undo.selection[field] !== undefined &&
            settled[field] !== undo.selection[field]
          )
            throw new Error(
              "BB could not restore the original settings. Your current draft is preserved.",
            );
        }
        const oldEnvironment = undo.selection.environment;
        if (
          oldEnvironment?.type === "reuse" &&
          (settled.environment?.type !== "reuse" ||
            settled.environment.environmentId !== oldEnvironment.environmentId)
        )
          throw new Error(
            "The original environment is unavailable. Your current draft is preserved.",
          );
        if (
          oldEnvironment?.type === "host" &&
          oldEnvironment.hostId &&
          selectionSnapshot(settled).hostId !== oldEnvironment.hostId
        )
          throw new Error(
            "The original machine is unavailable. Your current draft is preserved.",
          );
        activeOwner = settledOwner(settled, activeOwner);
      }
      activeOwner.composer.replace((current) => {
        if (draftContentIdentity(current) !== expected)
          throw new Error(
            "The draft changed while restoring settings. Your current text and attachments are preserved.",
          );
        return undo.draft;
      });
      activeOwner.suppressAutomatic(
        draftFingerprint(
          activeOwner.composer.draft,
          activeOwner.composer.selection,
        ),
      );
      activeOwner.setUndo(null);
    } catch (e) {
      activeOwner.setError(
        e instanceof Error
          ? e.message
          : "Could not restore the previous settings. Check the selectors.",
      );
    } finally {
      finishPickerTransaction();
    }
  }

  if (composer.isEmpty) return null;
  const stale = run !== null && run.fingerprint !== fingerprint;
  const pending = loading || run?.status === "pending";
  const review = !stale ? run?.review : null;
  return (
    <section
      className="min-w-0 space-y-3 p-3 text-sm"
      aria-label="Prompt and settings review"
      aria-busy={pending || applying}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          {applying
            ? "Applying your review…"
            : pending
              ? "Reviewing prompt and settings…"
              : review
                ? "Prompt and settings review"
                : "Prompt Advisor"}
        </p>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending || applying}
          onClick={() => void start()}
        >
          {run?.status === "error" || error ? "Retry review" : "Review now"}
        </Button>
      </div>
      {pending && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground" role="status">
            You can keep editing. Your selections stay in place until you apply
            changes.
          </p>
          <Button size="sm" variant="outline" onClick={() => void dismiss()}>
            Cancel review
          </Button>
        </div>
      )}
      {(error || run?.error) && (
        <p className="text-destructive" role="alert">
          {error ?? run?.error}
        </p>
      )}
      {undo && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status">Review applied. Ready when you are.</p>
          <Button variant="outline" size="sm" onClick={() => void restore()}>
            Undo
          </Button>
        </div>
      )}
      {review && (
        <>
          <p className="text-muted-foreground">{review.summary}</p>
          <details open>
            <summary className="cursor-pointer font-medium">
              Improved prompt
            </summary>
            <p className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap break-words text-foreground">
              {review.prompt}
            </p>
          </details>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={usePrompt}
              disabled={applying}
              onChange={(e) => setUsePrompt(e.target.checked)}
            />
            Use improved prompt
          </label>
          {review.questions.length > 0 && (
            <div>
              <p className="mb-1 font-medium">Information to clarify</p>
              <ul className="list-disc space-y-1 pl-5">
                {review.questions.map((q) => (
                  <li key={q} className="break-words">
                    {q}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-muted-foreground">
                Add answers to the draft and review again when they affect the
                task.
              </p>
            </div>
          )}
          {review.recommendations.length > 0 ? (
            <div className="divide-y divide-border">
              {review.recommendations.map((rec) => (
                <label key={rec.field} className="flex items-start gap-3 py-2">
                  <input
                    className="mt-1"
                    type="checkbox"
                    disabled={
                      applying || rec.confidence < MIN_RECOMMENDATION_CONFIDENCE
                    }
                    checked={fields.includes(rec.field)}
                    onChange={(e) =>
                      setFields((old) =>
                        e.target.checked
                          ? [...old, rec.field]
                          : old.filter((f) => f !== rec.field),
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block font-medium break-words">
                      {labels[rec.field]}: {settingLabel(rec)}
                    </span>
                    <span className="block text-muted-foreground break-words">
                      {rec.reason}
                    </span>
                    {rec.confidence < MIN_RECOMMENDATION_CONFIDENCE && (
                      <span className="block text-muted-foreground">
                        Uncertain suggestion — select this manually if
                        appropriate.
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">
              Your current execution settings fit this task.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={applying || (!usePrompt && !fields.length)}
              onClick={() => void apply(true)}
            >
              {applying ? "Applying…" : "Apply selected & start"}
            </Button>
            <Button
              variant="outline"
              disabled={applying || (!usePrompt && !fields.length)}
              onClick={() => void apply(false)}
            >
              Apply selected
            </Button>
            <Button
              variant="ghost"
              disabled={applying}
              onClick={() => void dismiss()}
            >
              Keep original
            </Button>
          </div>
        </>
      )}
      {!pending && !review && !error && !run?.error && !undo && (
        <p className="text-muted-foreground">
          Reviews your initial prompt and checks whether the model, reasoning,
          speed, project, and machine fit the task.
        </p>
      )}
    </section>
  );
}
export default definePluginApp((app) => {
  app.composer.customize({
    id: "prompt-and-settings-review",
    scopes: ["new-thread"],
    banners: [{ id: "review", component: ReviewBanner }],
    sendMenu: [
      {
        id: "review-first",
        label: "Review prompt and settings",
        description: "Check your draft and execution settings before starting.",
        disabled: (composer) => composer.isEmpty,
        run: ({ composer }) => {
          window.dispatchEvent(
            new CustomEvent(REQUEST_REVIEW, { detail: { key: composer.key } }),
          );
        },
      },
    ],
  });
});
