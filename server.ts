import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  answerSchema,
  buildReviewPrompt,
  catalogSchema,
  recommendationSchema,
  parseReview,
  reviewSchema,
  reviewSelectionSchema,
  validateRecommendations,
  type Catalog,
  type ReviewSelection,
} from "./lib/review";
import { machineContract } from "./lib/machine-contract";
import { DEFAULT_PAUSE_MS } from "./lib/trigger";

export const runSchema = z.object({
  id: z.string(),
  scopeKey: z.string(),
  fingerprint: z.string(),
  original: z.string(),
  selection: reviewSelectionSchema,
  resolvedSelection: reviewSelectionSchema.nullable(),
  status: z.enum(["pending", "done", "error", "cancelled"]),
  review: reviewSchema.nullable(),
  catalog: catalogSchema.nullable(),
  answers: z.array(answerSchema).nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  deadline: z.number(),
});
export const rpcContract = defineRpcContract({
  startReview: {
    input: z
      .object({
        scopeKey: z.string().min(1).max(500),
        fingerprint: z.string().min(1).max(100000),
        text: z
          .string()
          .min(1)
          .max(16000)
          .refine((s) => s.trim().length > 0),
        selection: reviewSelectionSchema,
        mentionLabels: z.array(z.string().max(1000)).max(100),
        attachmentCount: z.number().int().min(0).max(100),
        // Answers to the questions of review `refineFrom`, folded into a fresh review.
        refineFrom: z.string().max(100).optional(),
        answers: z.array(answerSchema).min(1).max(3).optional(),
      })
      .strict()
      .refine((x) => !x.answers === !x.refineFrom),
    output: runSchema,
  },
  getReview: {
    input: z.object({ id: z.string() }).strict(),
    output: runSchema.nullable(),
  },
  resume: {
    input: z.object({ scopeKey: z.string() }).strict(),
    output: runSchema.nullable(),
  },
  dismiss: { input: z.object({ id: z.string() }).strict(), output: z.null() },
  validateSettings: {
    input: z
      .object({
        id: z.string(),
        fields: z.array(recommendationSchema.shape.field).max(4),
        selection: reviewSelectionSchema,
      })
      .strict(),
    output: z.object({
      selection: reviewSelectionSchema,
      target: catalogSchema.shape.targets.element.nullable(),
    }),
  },
});
class ReviewFailure extends Error {}
type Run = z.infer<typeof runSchema>;
interface Row {
  id: string;
  scope_key: string;
  fingerprint: string;
  original: string;
  selection: string;
  resolved_selection: string | null;
  mentions: string;
  attachments: number;
  child_id: string | null;
  status: Run["status"];
  review: string | null;
  catalog: string | null;
  answers: string | null;
  refine_from: string | null;
  error: string | null;
  created_at: number;
  deadline: number;
  dismissed: number;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoReview: {
      type: "boolean",
      label: "Automatically review new-thread prompts",
      description:
        "Review after a pause in typing, only when the draft ends on a finished sentence. Review on demand with Ctrl+Shift+R (Control on macOS too) or Review now. Draft and settings change only when you apply a recommendation.",
      default: true,
    },
    debounceMs: {
      type: "number",
      label: "Pause before automatic review (milliseconds)",
      default: DEFAULT_PAUSE_MS,
      experimental_schema: z.number().int().min(5000).max(600000),
    },
    reviewerHost: {
      type: "string",
      label: "Review machine ID",
      description:
        "Leave blank to review on the BB server machine, independently of the task machine.",
      default: "",
    },
    reviewerProvider: {
      type: "string",
      label: "Review provider",
      default: "codex",
    },
    reviewerModel: {
      type: "string",
      label: "Review model",
      default: "gpt-6.1-sol",
    },
    reviewerReasoning: {
      type: "select",
      label: "Review reasoning",
      options: ["low", "medium", "high"],
      default: "medium",
    },
    reviewerTier: {
      type: "string",
      label: "Review service tier",
      default: "ultrafast",
    },
    customInstructions: {
      type: "string",
      label: "Prompt and routing preferences",
      experimental_multiline: true,
      default:
        "Keep my voice and scope. Prefer concise actionable prompts. Use the VPS for ordinary development when its checkout is available. Recommend a Mac when the task requires native macOS apps. Do not expand authority to deploy, publish, merge, or send messages.",
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE reviews (id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,fingerprint TEXT NOT NULL,original TEXT NOT NULL,selection TEXT NOT NULL,resolved_selection TEXT,mentions TEXT NOT NULL,attachments INTEGER NOT NULL,child_id TEXT,status TEXT NOT NULL,review TEXT,catalog TEXT,error TEXT,created_at INTEGER NOT NULL,deadline INTEGER NOT NULL,dismissed INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX reviews_scope ON reviews(scope_key,created_at)`,
    `ALTER TABLE reviews ADD COLUMN answers TEXT`,
    `ALTER TABLE reviews ADD COLUMN refine_from TEXT`,
  ]);
  const insert = db.prepare(
    `INSERT INTO reviews(id,scope_key,fingerprint,original,selection,mentions,attachments,answers,refine_from,status,created_at,deadline) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`,
  );
  const byId = db.prepare("SELECT * FROM reviews WHERE id=?");
  const pending = db.prepare("SELECT * FROM reviews WHERE status='pending'");
  const child = db.prepare(
    "SELECT * FROM reviews WHERE child_id=? AND status='pending'",
  );
  const latest = db.prepare(
    "SELECT * FROM reviews WHERE scope_key=? AND dismissed=0 ORDER BY created_at DESC LIMIT 1",
  );
  let disposed = false;
  const checking = new Set<string>();
  const machineClient = bb.hosts.experimental_client({
    contract: machineContract,
  });
  const catalogueCache = new Map<string, { at: number; value: Catalog }>();

  function row(id: string): Row | undefined {
    return byId.get(id) as Row | undefined;
  }
  function dto(r: Row): Run {
    return {
      id: r.id,
      scopeKey: r.scope_key,
      fingerprint: r.fingerprint,
      original: r.original,
      selection: reviewSelectionSchema.parse(JSON.parse(r.selection)),
      resolvedSelection: r.resolved_selection
        ? reviewSelectionSchema.parse(JSON.parse(r.resolved_selection))
        : null,
      status: r.status,
      review: r.review ? reviewSchema.parse(JSON.parse(r.review)) : null,
      catalog:
        r.status === "done" && r.catalog
          ? catalogSchema.parse(JSON.parse(r.catalog))
          : null,
      answers: r.answers
        ? z.array(answerSchema).parse(JSON.parse(r.answers))
        : null,
      error: r.error,
      createdAt: r.created_at,
      deadline: r.deadline,
    };
  }
  function notify(id: string) {
    if (!disposed) bb.realtime.publish("reviews", { id });
  }
  async function cleanup(id: string | null) {
    if (!id) return;
    try {
      await bb.sdk.threads.stop({ threadId: id });
    } catch {
      /* already idle */
    }
    try {
      await bb.sdk.threads.delete({
        threadId: id,
        childThreadsConfirmed: true,
      });
      if (!disposed)
        db.prepare("UPDATE reviews SET child_id=NULL WHERE child_id=?").run(id);
    } catch {
      /* retry via orphan cleanup below */
    }
  }
  function fail(r: Row, message: string) {
    if (disposed) return;
    const changed = db
      .prepare(
        "UPDATE reviews SET status='error',error=? WHERE id=? AND status='pending'",
      )
      .run(message, r.id).changes;
    if (changed) {
      notify(r.id);
      void cleanup(r.child_id);
    }
  }
  async function timeout<T>(call: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Catalogue lookup timed out.")),
            8000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function resolveSelection(
    input: ReviewSelection,
  ): Promise<ReviewSelection> {
    const result = { ...input };
    if (result.environmentId) {
      const env = await bb.sdk.environments.get({
        environmentId: result.environmentId,
      });
      if (env.projectId !== result.projectId)
        throw new ReviewFailure(
          "The selected environment belongs to a different project.",
        );
      result.hostId = env.hostId;
    }
    if (!result.hostId && result.projectId) {
      const project = await bb.sdk.projects.get({
        projectId: result.projectId,
      });
      result.hostId =
        (project.sources.find((s) => s.isDefault) ?? project.sources[0])
          ?.hostId ?? null;
    }
    return result;
  }
  async function loadCatalog(
    selection: ReviewSelection,
    fresh = false,
  ): Promise<Catalog> {
    const key = JSON.stringify([
      selection.projectId,
      selection.hostId,
      selection.environmentId,
    ]);
    const cached = catalogueCache.get(key);
    if (!fresh && cached && Date.now() - cached.at < 60000) return cached.value;
    const [projects, allHosts] = await Promise.all([
      timeout(bb.sdk.projects.list({ includePersonal: true })),
      timeout(bb.sdk.hosts.list()),
    ]);
    const hosts = allHosts.filter(
      (h) => h.status === "connected" && h.lifecycle.phase === "active",
    );
    const warnings: string[] = [];
    const facts = await Promise.all(
      hosts.map(async (h) => {
        let platform = "unknown";
        try {
          platform = (
            await timeout(machineClient.call("facts", null, { hostId: h.id }))
          ).platform;
        } catch {
          warnings.push(`Platform unavailable for ${h.name}.`);
        }
        return { host: h, platform };
      }),
    );
    const targets: Catalog["targets"] = [];
    const modelsByRoute = new Map<
      string,
      Promise<Catalog["targets"][number]["models"]>
    >();
    function modelsFor(route: { hostId: string } | { environmentId: string }) {
      const key = JSON.stringify(route);
      if (!modelsByRoute.has(key))
        modelsByRoute.set(
          key,
          (async () => {
            const providers = await timeout(bb.sdk.providers.list(route));
            const results = await Promise.allSettled(
              providers
                .filter(
                  (p) =>
                    p.available &&
                    ("environmentId" in route ||
                      p.capabilities.modelCatalogScope === "host"),
                )
                .map(async (provider) => {
                  const result = await timeout(
                    bb.sdk.providers.models({
                      ...route,
                      providerId: provider.id,
                    }),
                  );
                  const ranked = [...result.models].sort(
                    (a, b) =>
                      Number(b.model === selection.model || b.isDefault) -
                      Number(a.model === selection.model || a.isDefault),
                  );
                  if (ranked.length > 30)
                    warnings.push(
                      "Some older model options are omitted from this review.",
                    );
                  return ranked.slice(0, 30).map((m) => ({
                    providerId: provider.id,
                    model: m.model,
                    label: m.displayName,
                    description: m.description.slice(0, 350),
                    reasoningLevels: m.supportedReasoningEfforts.map(
                      (e) => e.reasoningEffort,
                    ),
                    serviceTiers: [
                      ...new Set([
                        "default",
                        ...(
                          m.supportedServiceTiers ??
                          provider.serviceTiers ??
                          []
                        ).map((t) => t.id),
                      ]),
                    ],
                  }));
                }),
            );
            if (results.some((r) => r.status === "rejected"))
              warnings.push("Some provider catalogues are unavailable.");
            return results.flatMap((r) =>
              r.status === "fulfilled" ? r.value : [],
            );
          })().catch(() => {
            warnings.push("A machine model catalogue is unavailable.");
            return [];
          }),
        );
      return modelsByRoute.get(key)!;
    }
    // Workspace-scoped providers are checked in each actual selected checkout. A host catalogue alone is insufficient.
    await Promise.all(
      projects.map(async (project) => {
        const sources =
          project.kind === "personal"
            ? facts.map((f) => ({
                hostId: f.host.id,
                path: null,
                isDefault: false,
              }))
            : project.sources;
        await Promise.all(
          sources.map(async (source) => {
            const machine = facts.find((f) => f.host.id === source.hostId);
            if (!machine) return;
            const route =
              selection.environmentId &&
              selection.projectId === project.id &&
              selection.hostId === source.hostId
                ? { environmentId: selection.environmentId }
                : { hostId: source.hostId };
            const models = await modelsFor(route);
            targets.push({
              id: `${project.id}:${source.hostId}`,
              projectId: project.id,
              projectName: project.name,
              hostId: source.hostId,
              machineName: machine.host.name,
              platform: machine.platform,
              path: source.path,
              personal: project.kind === "personal",
              models,
            });
          }),
        );
      }),
    );
    const value = catalogSchema.parse({
      targets: targets.sort((a, b) => a.id.localeCompare(b.id)),
      warnings: [...new Set(warnings)],
    });
    if (catalogueCache.size > 30) catalogueCache.clear();
    catalogueCache.set(key, { at: Date.now(), value });
    return value;
  }
  async function complete(r: Row, raw: string) {
    if (disposed || row(r.id)?.status !== "pending") return;
    try {
      const review = parseReview(raw, r.original, JSON.parse(r.mentions));
      db.prepare(
        "UPDATE reviews SET status='done',review=? WHERE id=? AND status='pending'",
      ).run(JSON.stringify(review), r.id);
      notify(r.id);
      void cleanup(r.child_id);
    } catch {
      fail(
        r,
        "The reviewer returned an invalid or incomplete review, or dropped a reference. Retry; your draft is unchanged.",
      );
    }
  }
  async function check(r: Row) {
    if (disposed || checking.has(r.id)) return;
    checking.add(r.id);
    try {
      if (Date.now() > r.deadline) {
        fail(r, "Review timed out. Retry or send your original prompt.");
        return;
      }
      if (!r.child_id) return;
      const thread = await bb.sdk.threads.get({ threadId: r.child_id });
      if (disposed) return;
      if (thread.status === "idle") {
        const result = await bb.sdk.threads.output({ threadId: r.child_id });
        if (result.output?.trim()) await complete(r, result.output);
        else
          fail(
            r,
            "The reviewer returned no review. Retry; your draft is unchanged.",
          );
      } else if (thread.status === "error")
        fail(
          r,
          "The review provider failed. Check its availability and retry.",
        );
    } catch {
      if (!disposed)
        fail(
          r,
          "The review thread is unavailable. Retry; your draft is unchanged.",
        );
    } finally {
      checking.delete(r.id);
    }
  }
  async function kickoff(id: string) {
    const r = row(id);
    if (!r) return;
    try {
      const selection = await resolveSelection(dto(r).selection);
      const catalog = await loadCatalog(selection);
      const prefs = await settings.get();
      const base = r.refine_from ? row(r.refine_from) : undefined;
      const refinement =
        base?.review && base.scope_key === r.scope_key && r.answers
          ? {
              previousPrompt: reviewSchema.parse(JSON.parse(base.review))
                .prompt,
              answers: z.array(answerSchema).parse(JSON.parse(r.answers)),
            }
          : null;
      if (r.refine_from && !refinement)
        throw new ReviewFailure(
          "The review those answers belong to is no longer available. Review again.",
        );
      const target = catalog.targets.find(
        (t) =>
          t.projectId === selection.projectId && t.hostId === selection.hostId,
      );
      if (!target)
        throw new ReviewFailure(
          "Select a connected project and machine before reviewing.",
        );
      const reviewerHost =
        prefs.reviewerHost.trim() ||
        (await bb.sdk.system.config()).primaryHostId;
      const home = catalog.targets.find(
        (t) => t.personal && t.hostId === reviewerHost,
      );
      if (!home)
        throw new ReviewFailure(
          "No connected personal workspace is available for the review machine.",
        );
      const reviewer = home.models.find(
        (m) =>
          m.providerId === prefs.reviewerProvider &&
          m.model === prefs.reviewerModel,
      );
      if (
        !reviewer ||
        !reviewer.reasoningLevels.includes(prefs.reviewerReasoning) ||
        !reviewer.serviceTiers.includes(prefs.reviewerTier)
      )
        throw new ReviewFailure(
          "Review model settings are unavailable on this machine. Change them in Prompt Advisor settings.",
        );
      // Review in a personal workspace, without inheriting a repository's task instructions.
      db.prepare(
        "UPDATE reviews SET catalog=?,resolved_selection=? WHERE id=?",
      ).run(JSON.stringify(catalog), JSON.stringify(selection), id);
      if (disposed || row(id)?.status !== "pending") return;
      const created = await bb.sdk.threads.spawn({
        projectId: home.projectId,
        environment: {
          type: "host",
          hostId: home.hostId,
          workspace: { type: "personal" },
        },
        providerId: prefs.reviewerProvider,
        model: prefs.reviewerModel,
        reasoningLevel: prefs.reviewerReasoning as "low" | "medium" | "high",
        serviceTier: prefs.reviewerTier,
        permissionMode: "accept-edits",
        visibility: "hidden",
        title: "Review prompt and settings",
        pluginMetadata: { reviewer: true, reviewId: id },
        prompt: buildReviewPrompt(
          r.original,
          selection,
          catalog,
          r.attachments,
          prefs.customInstructions,
          refinement,
        ),
      });
      if (disposed) {
        void cleanup(created.id);
        return;
      }
      db.prepare("UPDATE reviews SET child_id=? WHERE id=?").run(
        created.id,
        id,
      );
      if (row(id)?.status !== "pending") void cleanup(created.id);
    } catch (error) {
      if (!disposed)
        fail(
          row(id) ?? r,
          error instanceof ReviewFailure
            ? error.message
            : "Review could not start. Check provider availability and retry.",
        );
    }
  }

  bb.rpc.register(rpcContract, {
    async startReview(input) {
      const previous = latest.get(input.scopeKey) as Row | undefined;
      const answers = input.answers ? JSON.stringify(input.answers) : null;
      if (
        previous?.fingerprint === input.fingerprint &&
        previous.answers === answers &&
        previous.status !== "error" &&
        previous.status !== "cancelled"
      )
        return dto(previous);
      if (previous) {
        db.prepare("UPDATE reviews SET dismissed=1 WHERE id=?").run(
          previous.id,
        );
        if (previous.status === "pending") {
          db.prepare("UPDATE reviews SET status='cancelled' WHERE id=?").run(
            previous.id,
          );
          void cleanup(previous.child_id);
        }
      }
      const id = crypto.randomUUID(),
        now = Date.now();
      insert.run(
        id,
        input.scopeKey,
        input.fingerprint,
        input.text,
        JSON.stringify(input.selection),
        JSON.stringify(input.mentionLabels),
        input.attachmentCount,
        answers,
        input.refineFrom ?? null,
        now,
        now + 180000,
      );
      void kickoff(id);
      return dto(row(id)!);
    },
    getReview({ id }) {
      const r = row(id);
      return r ? dto(r) : null;
    },
    resume({ scopeKey }) {
      const r = latest.get(scopeKey) as Row | undefined;
      return r && Date.now() - r.created_at < 900000 ? dto(r) : null;
    },
    dismiss({ id }) {
      const r = row(id);
      if (r) {
        db.prepare(
          "UPDATE reviews SET dismissed=1,status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE id=?",
        ).run(id);
        void cleanup(r.child_id);
      }
      return null;
    },
    async validateSettings({ id, fields, selection }) {
      const r = row(id);
      if (!r || r.status !== "done" || !r.review)
        throw new Error("Review is no longer available.");
      if (JSON.stringify(selection) !== r.selection)
        throw new Error("Settings changed since this review. Review again.");
      const resolved = await resolveSelection(selection),
        catalog = await loadCatalog(resolved, true);
      const review = reviewSchema.parse(JSON.parse(r.review));
      const next = validateRecommendations(
        resolved,
        review.recommendations.filter((rec) => fields.includes(rec.field)),
        catalog,
      );
      return {
        selection: next,
        target:
          catalog.targets.find(
            (t) => t.projectId === next.projectId && t.hostId === next.hostId,
          ) ?? null,
      };
    },
  });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const r = child.get(thread.id) as Row | undefined;
    if (r) await complete(r, lastAssistantText ?? "");
  });
  bb.events.on("thread.failed", ({ thread }) => {
    const r = child.get(thread.id) as Row | undefined;
    if (r)
      fail(r, "The review provider failed. Check its availability and retry.");
  });
  // Poll only terminal thread states; a pause in streamed text is not completion.
  const interval = setInterval(() => {
    if (!disposed) for (const r of pending.all() as Row[]) void check(r);
  }, 2000);
  interval.unref();
  bb.onDispose(() => {
    disposed = true;
    clearInterval(interval);
  });
  let reconciling = false;
  async function reconcile() {
    if (disposed || reconciling) return;
    reconciling = true;
    try {
      const result = await bb.sdk.threads.list({
        originPluginId: bb.pluginId,
        includeHidden: true,
        limit: 100,
      });
      for (const thread of result) {
        if (disposed) return;
        if (thread.visibility !== "hidden") continue;
        const metadata = await bb.sdk.threads.getPluginMetadata({
          threadId: thread.id,
        });
        const id =
          typeof metadata.reviewId === "string" ? metadata.reviewId : null;
        if (!id) continue;
        const found = row(id);
        if (found?.status === "pending") {
          if (found.child_id === null)
            db.prepare("UPDATE reviews SET child_id=? WHERE id=?").run(
              thread.id,
              id,
            );
        } else void cleanup(thread.id);
      }
    } catch {
      /* Catalogue/recovery is retried; no raw provider error enters the UI. */
    } finally {
      reconciling = false;
    }
  }
  void reconcile();
  const reconcileTimer = setInterval(() => void reconcile(), 10000);
  reconcileTimer.unref();
  bb.onDispose(() => clearInterval(reconcileTimer));
  for (const r of pending.all() as Row[]) if (r.child_id) void check(r);
  // Own only these hidden reviewer threads. Retain failed cleanup rows for retry.
  const terminal = db
    .prepare(
      "SELECT * FROM reviews WHERE status<>'pending' AND child_id IS NOT NULL",
    )
    .all() as Row[];
  for (const r of terminal) void cleanup(r.child_id);
  db.prepare(
    "DELETE FROM reviews WHERE created_at<? AND status<>'pending' AND child_id IS NULL",
  ).run(Date.now() - 7 * 86400000);
}
