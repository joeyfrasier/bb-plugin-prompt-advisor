// bb-plugin-prompt-enhancer — review panel.
//
// "Review now" / "Review again" rewrites the draft AND checks execution
// settings (model/reasoning level/service tier) against the task, using the
// exact same hidden-child-thread machinery as the enhance feature's button
// (server.ts's shared JobRunner). Unlike enhance, review never writes into
// the draft on its own: it shows a panel with the proposed rewrite (a
// change-only view, with an optional word diff), settings shown as
// current -> proposed with their reasons collapsed, and any material
// questions the reviewer needs answered — and the user applies what they
// want from there.
//
// Like the enhance feature's run, a review belongs to a composer SCOPE, not
// to this mounted component: `resumeReviewForScope` on mount picks up
// whatever this scope's most recent undismissed review is, so leaving and
// returning to a thread does not lose it.
import { useEffect, useRef, useState } from "react";
import { useComposer, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { diffWords } from "@/lib/diff";
import { reanchorMentions } from "@/lib/mentions";
import { scopeKey as scopeKeyOf } from "@/lib/scope-key";
import {
  validateRecommendations,
  type Answer,
  type Catalog,
  type Recommendation,
  type Review,
  type ReviewSelection,
} from "@/lib/review";

/** Matches server.ts's REVIEW_CHANNEL literal; channel names are plain
 * strings shared by convention, the same way the enhance feature's own
 * "prompt-enhancer" channel is. */
const REVIEW_CHANNEL = "prompt-advisor-review";

type ComposerScope = ReturnType<typeof useComposer>["scope"];
/** The getReview/resumeReviewForScope/startReview output shape, read off the
 * contract's own zod schema rather than re-declared here. */
type ReviewRun = NonNullable<ReturnType<typeof rpcContract.getReview.output.parse>>;

function scopeKey(scope: ComposerScope): string {
  return scopeKeyOf(scope);
}

/** Current execution settings as the review/recommendation machinery sees
 * them: whatever the composer's own pickers currently hold (null fields on a
 * composer with no pickers, e.g. a queued-message editor). */
function currentSelection(
  selection: { providerId?: string; model?: string; reasoningLevel?: string; serviceTier?: string } | null,
): ReviewSelection {
  return {
    providerId: selection?.providerId ?? null,
    model: selection?.model ?? null,
    reasoningLevel: selection?.reasoningLevel ?? null,
    serviceTier: selection?.serviceTier ?? null,
  };
}

const FIELD_LABEL: Record<Recommendation["field"], string> = {
  model: "Model",
  reasoningLevel: "Reasoning",
  serviceTier: "Service tier",
};

export function ReviewPanel() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const [run, setRun] = useState<ReviewRun | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [applyingSettings, setApplyingSettings] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const runRef = useRef<ReviewRun | null>(null);
  runRef.current = run;

  const myScopeKey = scopeKey(composer.scope);
  const busy = run?.status === "pending";
  const triggerDisabled = !busy && composer.isEmpty;

  function resetPanelState(): void {
    setShowChanges(false);
    setShowWhy(false);
    setAnswerDrafts({});
  }

  // Adopt whatever this scope's latest undismissed review is, on mount and
  // on every scope change — the component that started a review is usually
  // not the one still mounted once it finishes.
  useEffect(() => {
    let abandoned = false;
    setRun(null);
    resetPanelState();
    void (async () => {
      try {
        const resumed = await rpc.call("resumeReviewForScope", {
          scopeKey: myScopeKey,
        });
        if (!abandoned && resumed !== null) setRun(resumed);
      } catch {
        // Nothing resumable, or the server is unreachable; the trigger still works.
      }
    })();
    return () => {
      abandoned = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myScopeKey]);

  // Review has no progressive paint into the draft (unlike enhance): a
  // terminal signal just means "re-fetch this run and show the result".
  useRealtime(REVIEW_CHANNEL, (payload) => {
    const signal = payload as { id?: string; status?: string };
    const id = runRef.current?.id;
    if (id === undefined || signal.id !== id) return;
    if (signal.status === "progress") return;
    void rpc
      .call("getReview", { id })
      .then((updated) => {
        if (updated !== null && runRef.current?.id === updated.id) setRun(updated);
      })
      .catch(() => {
        // Transient; the next signal or a manual retry will catch it up.
      });
  });

  async function review(refine?: {
    refineFrom: string;
    answers: Answer[];
  }): Promise<void> {
    const text = composer.text.trim();
    if (!text) return;
    const { mentions } = composer.draft;
    const mentionLabels = mentions.map((mention) => mention.label);
    const selection = currentSelection(composer.selection);
    const scope = composer.scope;
    const threadId =
      scope.kind === "thread" || scope.kind === "queued-message" ? scope.threadId : null;
    const projectId = scope.kind === "new-thread" ? scope.projectId : null;
    const fingerprint = JSON.stringify({
      text,
      selection,
      mentionLabels,
      attachmentCount: composer.attachmentCount,
    });
    try {
      const next = await rpc.call("startReview", {
        scopeKey: myScopeKey,
        fingerprint,
        text,
        threadId,
        projectId,
        selection,
        mentionLabels: [...mentionLabels],
        attachmentCount: composer.attachmentCount,
        ...(refine ? { refineFrom: refine.refineFrom, answers: refine.answers } : {}),
      });
      setRun(next);
      resetPanelState();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start review");
    }
  }

  function dismiss(): void {
    const id = run?.id;
    setRun(null);
    resetPanelState();
    if (id !== undefined) void rpc.call("dismissReview", { id }).catch(() => {});
  }

  function applyRewrite(): void {
    if (run?.review === null || run?.review === undefined) return;
    const prompt = run.review.prompt;
    try {
      composer.replace({
        text: prompt,
        mentions: reanchorMentions(composer.draft, prompt),
      });
      composer.focus();
      toast.success("Review applied to your draft");
    } catch {
      // Composer scope is gone; nothing to apply into.
    }
  }

  /**
   * Validate recommendations against the catalog snapshot this review ran
   * against, then apply the result straight through the composer's own
   * picker state — no server round trip, since lib/review.ts (no SDK
   * import) can run entirely on the client.
   */
  async function applySettings(): Promise<void> {
    if (run?.review === null || run?.review === undefined || run.catalog === null) return;
    setApplyingSettings(true);
    try {
      const next = validateRecommendations(
        currentSelection(composer.selection),
        run.review.recommendations,
        run.catalog,
      );
      // ComposerSelection takes undefined ("leave alone") where
      // ReviewSelection takes null ("no value").
      await composer.setSelection({
        ...(next.providerId !== null ? { providerId: next.providerId } : {}),
        ...(next.model !== null ? { model: next.model } : {}),
        ...(next.reasoningLevel !== null ? { reasoningLevel: next.reasoningLevel } : {}),
        ...(next.serviceTier !== null ? { serviceTier: next.serviceTier } : {}),
      });
      toast.success("Settings applied");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not apply the recommended settings",
      );
    } finally {
      setApplyingSettings(false);
    }
  }

  function submitAnswers(): void {
    if (run === null || run.review === null) return;
    const answers: Answer[] = run.review.questions
      .map((question) => ({
        question: question.question,
        answer: (answerDrafts[question.question] ?? "").trim(),
      }))
      .filter((answer): answer is Answer => answer.answer.length > 0);
    if (answers.length === 0) return;
    void review({ refineFrom: run.id, answers });
  }

  // Physical Ctrl+Shift+R on every platform: Cmd+Shift+R is hard reload in
  // Mac browsers and Electron, so only the Control key counts here — no
  // Meta+Shift+R variant. Ownership mirrors the enhance button's Cmd/Ctrl+E:
  // only the instance whose composer contains the focused editor reacts.
  const reviewRef = useRef<() => void>(() => {});
  reviewRef.current = () => void review();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.ctrlKey || event.metaKey || event.altKey || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "r") return;
      const container = rootRef.current?.closest("[data-promptbox-main]");
      const active = document.activeElement;
      if (!container || active === null || !container.contains(active)) return;
      event.preventDefault();
      event.stopPropagation();
      reviewRef.current();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const review_: Review | null = run?.review ?? null;
  const diffParts =
    showChanges && review_ !== null && run !== null ? diffWords(run.original, review_.prompt) : null;
  const hasRecommendations = (review_?.recommendations.length ?? 0) > 0;
  const hasQuestions = (review_?.questions.length ?? 0) > 0;
  const hasWhy = hasRecommendations || (review_?.changes.length ?? 0) > 0;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="Prompt review"
      aria-busy={busy}
      className="flex items-center"
    >
      <Popover open={run !== null} onOpenChange={(open) => { if (!open) dismiss(); }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-keyshortcuts="Control+Shift+R"
            aria-label={run === null ? "Review prompt" : "Review again"}
            title={`${run === null ? "Review prompt" : "Review again"} (Ctrl+Shift+R)`}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
              "max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-9",
              "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
            disabled={triggerDisabled}
            onClick={() => void review()}
          >
            <Icon
              name={busy ? "Loading" : "CircleCheck"}
              className={cn("size-4 max-md:pointer-coarse:size-5", busy && "animate-spin")}
              aria-hidden
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-96 max-h-[70vh] overflow-y-auto"
          mobileTitle="Prompt review"
        >
          {run === null ? null : (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">Prompt review</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Dismiss review"
                  onClick={dismiss}
                  className="h-6 w-6"
                >
                  <Icon name="X" className="size-4" aria-hidden />
                </Button>
              </div>

              {run.status === "pending" ? (
                <p className="text-muted-foreground">Reviewing your prompt…</p>
              ) : run.status === "error" ? (
                <div className="flex flex-col gap-2">
                  <p className="flex items-center gap-1.5 text-destructive">
                    <Icon name="AlertTriangle" className="size-4 shrink-0" aria-hidden />
                    {run.error ?? "Review failed"}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => void review()}>
                    Try again
                  </Button>
                </div>
              ) : review_ === null ? null : (
                <>
                  {/* Change-only layout: the rewrite itself, with an opt-in diff. */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      Proposed prompt
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-xs"
                      onClick={() => setShowChanges((value) => !value)}
                    >
                      <Icon name="FileDiff" className="size-3.5" aria-hidden />
                      {showChanges ? "Hide changes" : "Show changes"}
                    </Button>
                  </div>
                  <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-input p-2 text-xs">
                    {diffParts !== null
                      ? diffParts.map((part, index) => (
                          <span
                            key={index}
                            className={
                              part.kind === "added"
                                ? "bg-green-500/20 text-foreground"
                                : part.kind === "removed"
                                  ? "text-muted-foreground line-through opacity-70"
                                  : undefined
                            }
                          >
                            {part.text}
                          </span>
                        ))
                      : review_.prompt}
                  </div>

                  {hasRecommendations ? (
                    <div className="flex flex-col gap-1.5 rounded-md border border-input p-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Settings
                      </span>
                      {review_.recommendations.map((rec) => (
                        <div
                          key={rec.field}
                          className="flex items-center justify-between gap-2 text-xs"
                        >
                          <span className="text-muted-foreground">{FIELD_LABEL[rec.field]}</span>
                          <span className="flex items-center gap-1 truncate">
                            <span className="truncate text-muted-foreground">
                              {run.resolvedSelection?.[rec.field] ?? "default"}
                            </span>
                            <Icon name="ArrowRight" className="size-3 shrink-0" aria-hidden />
                            <span className="truncate font-medium">{rec.value}</span>
                          </span>
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-1"
                        disabled={applyingSettings || run.catalog === null}
                        onClick={() => void applySettings()}
                      >
                        Apply settings
                      </Button>
                    </div>
                  ) : null}

                  {hasWhy ? (
                    <div>
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                        onClick={() => setShowWhy((value) => !value)}
                        aria-expanded={showWhy}
                      >
                        <Icon
                          name={showWhy ? "ChevronUp" : "ChevronDown"}
                          className="size-3.5"
                          aria-hidden
                        />
                        Why these changes
                      </button>
                      {showWhy ? (
                        <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                          {review_.changes.map((change, index) => (
                            <li key={`change-${index}`}>{change}</li>
                          ))}
                          {review_.recommendations.map((rec) => (
                            <li key={`reason-${rec.field}`}>
                              {FIELD_LABEL[rec.field]}: {rec.reason}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  {hasQuestions ? (
                    <div className="flex flex-col gap-2 rounded-md border border-input p-2">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <Icon name="MessageQuestion" className="size-3.5" aria-hidden />
                        A couple of questions
                      </span>
                      {review_.questions.map((question) => (
                        <div key={question.question} className="flex flex-col gap-1">
                          <span className="text-xs">{question.question}</span>
                          {question.options.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {question.options.map((option) => (
                                <Button
                                  key={option}
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  aria-pressed={answerDrafts[question.question] === option}
                                  className="h-6 px-2 text-xs"
                                  onClick={() =>
                                    setAnswerDrafts((drafts) => ({
                                      ...drafts,
                                      [question.question]: option,
                                    }))
                                  }
                                >
                                  {option}
                                </Button>
                              ))}
                            </div>
                          ) : (
                            <Input
                              value={answerDrafts[question.question] ?? ""}
                              placeholder="Your answer…"
                              className="h-7 text-xs"
                              onChange={(event) =>
                                setAnswerDrafts((drafts) => ({
                                  ...drafts,
                                  [question.question]: event.target.value,
                                }))
                              }
                            />
                          )}
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Object.values(answerDrafts).every((value) => value.trim().length === 0)}
                        onClick={submitAnswers}
                      >
                        Submit answers
                      </Button>
                    </div>
                  ) : null}

                  <Button size="sm" onClick={applyRewrite}>
                    Apply rewrite
                  </Button>
                </>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
