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
import { Input } from "./components/ui/input";
import {
  MIN_RECOMMENDATION_CONFIDENCE,
  reviewSelectionSchema,
  remapMentions,
  validateRecommendations,
  type Answer,
  type Recommendation,
  type ReviewSelection,
} from "./lib/review";
import {
  DEFAULT_PAUSE_MS,
  MIN_AUTOMATIC_GAP_MS,
  REVIEW_SHORTCUT,
  looksFinished,
  pauseLabel,
  shortcutLabel,
} from "./lib/trigger";
import { diffWords, sameText } from "./lib/diff";
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
    [usePrompt, setUsePrompt] = useState(true),
    [showDiff, setShowDiff] = useState(false),
    [answers, setAnswers] = useState<Record<number, string>>({});
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

  const start = useCallback(
    async (refine?: { refineFrom: string; answers: Answer[] }) => {
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
          ...(refine ?? {}),
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
    },
    [composer, rpc, adopt],
  );

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
      !looksFinished(composer.text) ||
      fingerprint === attempted.current ||
      applyingRef.current ||
      isPickerTransaction(composer.selection?.projectId) ||
      undo
    )
      return;
    const pause =
      typeof settings.values?.debounceMs === "number"
        ? settings.values?.debounceMs
        : DEFAULT_PAUSE_MS;
    const delay = Math.max(
      pause,
      MIN_AUTOMATIC_GAP_MS - (Date.now() - lastAutomatic.current),
    );
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

  useEffect(() => {
    setAnswers({});
    setShowDiff(false);
  }, [run?.id]);
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
  function settingLabel(
    field: Recommendation["field"],
    value: string | null,
    providerId?: string | null,
  ): string {
    if (value === null) return "default";
    if (field === "target") {
      const target = run?.catalog?.targets.find((t) => t.id === value);
      return target ? `${target.projectName} · ${target.machineName}` : value;
    }
    if (field === "model")
      return (
        run?.catalog?.targets
          .flatMap((t) => t.models)
          .find((m) => m.model === value && m.providerId === providerId)
          ?.label ?? value
      );
    return value;
  }
  function currentLabel(field: Recommendation["field"]): string {
    const now = run?.resolvedSelection ?? run?.selection;
    if (!now) return "default";
    if (field === "target")
      return now.projectId && now.hostId
        ? settingLabel(field, `${now.projectId}:${now.hostId}`)
        : "default";
    if (field === "model")
      return settingLabel(field, now.model, now.providerId);
    return settingLabel(field, now[field]);
  }
  function refine() {
    const questions = run?.review?.questions ?? [];
    const answered = questions.flatMap((q, i) => {
      const answer = answers[i]?.trim();
      return answer ? [{ question: q.question, answer }] : [];
    });
    if (run && answered.length)
      void start({ refineFrom: run.id, answers: answered });
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
    const takePrompt =
      usePrompt && !sameText(run.review.prompt, beforeDraft.text);
    try {
      const mentions = takePrompt
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
      if (takePrompt)
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
  const review = !stale && run ? run.review : null;
  const failure = error ?? run?.error ?? null;
  const shortcut = shortcutLabel();
  const pause =
    typeof settings.values?.debounceMs === "number"
      ? settings.values.debounceMs
      : DEFAULT_PAUSE_MS;
  const rewritten = review !== null && !sameText(review.prompt, run!.original);
  const answeredCount = review
    ? review.questions.filter((_, i) => answers[i]?.trim()).length
    : 0;
  const nothingSelected = !(usePrompt && rewritten) && fields.length === 0;
  const allGood =
    review !== null &&
    !rewritten &&
    review.recommendations.length === 0 &&
    review.questions.length === 0;
  const why = review
    ? [
        ...review.changes,
        ...(review.summary ? [review.summary] : []),
        ...review.recommendations.map((r) => `${labels[r.field]}: ${r.reason}`),
        ...(run?.catalog?.warnings ?? []),
      ]
    : [];
  const title = applying
    ? "Applying review…"
    : pending
      ? "Reviewing prompt…"
      : review
        ? "Proposed changes"
        : "Prompt review";
  const status = pending
    ? "Editing the draft cancels this review."
    : review && run?.answers?.length
      ? `Updated with ${run.answers.length === 1 ? "your answer" : `${run.answers.length} answers`}.`
      : !review && !failure && !undo
        ? settings.values?.autoReview !== true
          ? "Automatic review is off."
          : looksFinished(composer.text)
            ? `Reviews automatically after ${pauseLabel(pause)} without typing.`
            : "Automatic review waits for a finished sentence."
        : null;
  return (
    <section
      className="min-w-0 space-y-3 p-3 text-sm"
      aria-label="Prompt review"
      aria-busy={pending || applying}
    >
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h2 className="text-sm font-medium">{title}</h2>
          {status && (
            <p className="text-xs text-muted-foreground" role="status">
              {status}
            </p>
          )}
        </div>
        {pending ? (
          <Button size="sm" variant="ghost" onClick={() => void dismiss()}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant={review ? "ghost" : "outline"}
            disabled={applying}
            aria-keyshortcuts="Control+Shift+R"
            onClick={() => void start()}
          >
            {failure ? "Retry review" : review ? "Review again" : "Review now"}
            <kbd className="font-sans text-xs font-normal text-muted-foreground">
              {shortcut}
            </kbd>
          </Button>
        )}
      </header>
      {failure && (
        <p className="text-destructive" role="alert">
          {failure}
        </p>
      )}
      {undo && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status">Applied to your draft.</p>
          <Button variant="outline" size="sm" onClick={() => void restore()}>
            Undo
          </Button>
        </div>
      )}
      {review && allGood && (
        <p className="text-muted-foreground">
          Your prompt and settings already fit this task.
        </p>
      )}
      {review && rewritten && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={usePrompt}
                disabled={applying}
                onChange={(e) => setUsePrompt(e.target.checked)}
              />
              Rewritten prompt
            </label>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={showDiff}
              onClick={() => setShowDiff((value) => !value)}
            >
              Show changes
            </Button>
          </div>
          <div
            className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2 leading-relaxed text-foreground"
            tabIndex={0}
            aria-label={
              showDiff
                ? "Changes from your draft to the rewritten prompt"
                : "Rewritten prompt"
            }
          >
            {showDiff
              ? diffWords(run!.original, review.prompt).map((part, i) =>
                  part.kind === "same" ? (
                    <span key={i}>{part.text}</span>
                  ) : part.kind === "added" ? (
                    <ins
                      key={i}
                      className="rounded-sm bg-emerald-500/15 text-foreground no-underline"
                    >
                      {part.text}
                    </ins>
                  ) : part.text.trim() ? (
                    <del
                      key={i}
                      className="rounded-sm bg-destructive/10 text-muted-foreground decoration-destructive/60"
                    >
                      {part.text}
                    </del>
                  ) : null,
                )
              : review.prompt}
          </div>
        </div>
      )}
      {review && review.recommendations.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="sr-only">Setting changes</legend>
          {review.recommendations.map((rec) => {
            const uncertain = rec.confidence < MIN_RECOMMENDATION_CONFIDENCE;
            return (
              <label
                key={rec.field}
                className="flex min-w-0 flex-wrap items-center gap-x-2"
              >
                <input
                  type="checkbox"
                  disabled={applying || uncertain}
                  checked={fields.includes(rec.field)}
                  onChange={(e) =>
                    setFields((old) =>
                      e.target.checked
                        ? [...old, rec.field]
                        : old.filter((f) => f !== rec.field),
                    )
                  }
                />
                <span className="font-medium">{labels[rec.field]}</span>
                <span className="min-w-0 break-words text-muted-foreground">
                  {currentLabel(rec.field)} →{" "}
                  <span className="text-foreground">
                    {settingLabel(rec.field, rec.value, rec.providerId)}
                  </span>
                </span>
                {uncertain && (
                  <span className="text-xs text-muted-foreground">
                    (uncertain; change it yourself if it fits)
                  </span>
                )}
              </label>
            );
          })}
        </fieldset>
      )}
      {review && review.questions.length > 0 && (
        <div className="space-y-3 border-t border-border pt-3">
          {review.questions.map((q, i) => (
            <div key={`${run!.id}:${i}`} className="space-y-1.5">
              <p id={`${run!.id}-q${i}`} className="break-words font-medium">
                {q.question}
              </p>
              {q.options.length > 0 && (
                <div
                  className="flex flex-wrap gap-1.5"
                  role="group"
                  aria-labelledby={`${run!.id}-q${i}`}
                >
                  {q.options.map((option) => (
                    <Button
                      key={option}
                      size="sm"
                      variant="outline"
                      className="h-7 rounded-full px-2.5 font-normal aria-pressed:border-foreground aria-pressed:bg-state-active"
                      aria-pressed={answers[i] === option}
                      disabled={applying}
                      onClick={() =>
                        setAnswers((old) => ({
                          ...old,
                          [i]: old[i] === option ? "" : option,
                        }))
                      }
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              )}
              <Input
                className="h-8"
                aria-labelledby={`${run!.id}-q${i}`}
                placeholder={
                  q.options.length ? "Or write your own answer" : "Your answer"
                }
                value={answers[i] ?? ""}
                disabled={applying}
                onChange={(e) =>
                  setAnswers((old) => ({ ...old, [i]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    refine();
                  }
                }}
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              size="sm"
              variant="secondary"
              disabled={applying || answeredCount === 0}
              onClick={refine}
            >
              {answeredCount > 1
                ? "Update prompt with answers"
                : "Update prompt with answer"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Unanswered questions stay open.
            </p>
          </div>
        </div>
      )}
      {review && !allGood && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            disabled={applying || nothingSelected}
            onClick={() => void apply(true)}
          >
            {applying ? "Applying…" : "Apply & start"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={applying || nothingSelected}
            onClick={() => void apply(false)}
          >
            Apply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={applying}
            onClick={() => void dismiss()}
          >
            Keep original
          </Button>
        </div>
      )}
      {review && allGood && (
        <Button size="sm" variant="ghost" onClick={() => void dismiss()}>
          Dismiss
        </Button>
      )}
      {review && why.length > 0 && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer text-xs font-medium">
            Why these changes
          </summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs">
            {why.map((line, i) => (
              <li key={i} className="break-words">
                {line}
              </li>
            ))}
            {run?.answers?.map((a, i) => (
              <li key={`a${i}`} className="break-words">
                You answered “{a.question}”: {a.answer}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
/** Ask the mounted review banner for this composer to review now. */
export function requestReview(key: string) {
  window.dispatchEvent(new CustomEvent(REQUEST_REVIEW, { detail: { key } }));
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
        description: `Rewrite your draft and check its settings before starting (${shortcutLabel()}).`,
        disabled: (composer) => composer.isEmpty,
        run: ({ composer }) => requestReview(composer.key),
      },
    ],
  });
  app.composer.experimental_registerCommand({
    id: "review-prompt",
    title: "Review prompt and settings",
    defaultShortcut: REVIEW_SHORTCUT,
    run: ({ composer }) => {
      if (composer.scope.kind === "new-thread" && !composer.isEmpty)
        requestReview(composer.key);
    },
  });
});
