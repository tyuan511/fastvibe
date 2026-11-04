import { isUsableImageModel } from "../../shared/image-model.ts";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImageConfig, ImageGenerateRequest, ImageOptions, ImageReferenceInput, ImageSession, ImageSnapshot, ImageTask, ImagesChanged } from "../../shared/image-generation.ts";
import { openDatabase, type Db } from "../engine/db.ts";
import type { FastVibePaths } from "../engine/paths.ts";
import { uiText } from "../engine/ui-text.ts";
import { assertActive, MAX_REFERENCES, MAX_REFERENCE_BYTES, prepareReferences, saveImage } from "./assets.ts";
import { generateProtocolImage, normalizeOpenAiOptions, redact } from "./protocol.ts";

export type ImageGenerationServiceOptions = {
  paths: FastVibePaths;
  getConfig: () => Promise<ImageConfig>;
  resolveProviderKey: (providerId: string) => Promise<string | undefined>;
  onChanged?: (event: ImagesChanged) => void;
  fetch?: typeof fetch;
};
type Running = { controller: AbortController; done: Promise<void> };

/** Durable metadata, independent async HTTP jobs, and image files share one owner. */
export class ImageGenerationService {
  readonly #db: Db;
  readonly #root: string;
  readonly #options: ImageGenerationServiceOptions;
  readonly #fetch: typeof fetch;
  readonly #running = new Map<string, Running>();
  readonly #progress = new Map<string, Set<(task: ImageTask) => void>>();
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #deletingSessions = new Set<string>();
  #disposed = false;
  #disposePromise?: Promise<void>;

  constructor(options: ImageGenerationServiceOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#root = join(options.paths.runtimeRoot, "image-generation");
    this.#db = openDatabase(options.paths.databaseFile);
    // A previous process may have paid for a request already. Never automatically resend it.
    const unfinished = this.#db.all<{ data: string }>("SELECT data FROM image_tasks").map((row) => JSON.parse(row.data) as ImageTask).filter((task) => task.status === "generating");
    if (unfinished.length) {
      this.#db.transaction(() => {
        for (const task of unfinished) this.#writeTask({ ...task, status: "interrupted", completedAt: Date.now(), error: uiText("应用退出，图片生成已中断。请核对结果后重试。", "Image generation was interrupted when the app closed. Check the result before retrying.") });
        this.#advanceRevision();
      });
    }
  }

  async getConfig(): Promise<ImageConfig> {
    this.#ensureOpen();
    return this.#options.getConfig();
  }

  modelsChanged(): void {
    this.#ensureOpen();
    this.#changed();
  }

  async snapshot(sessionId?: string): Promise<ImageSnapshot> {
    this.#ensureOpen();
    // Covers are derived, not stored: the newest task image per session, read while listing.
    const previews = this.#sessionPreviews();
    return {
      revision: this.#revision(),
      sessions: this.#db.all<{ data: string }>("SELECT data FROM image_sessions ORDER BY updated_at DESC, id").map((row) => {
        const session = JSON.parse(row.data) as ImageSession;
        const previewPath = previews.get(session.id);
        return previewPath ? { ...session, previewPath } : session;
      }),
      tasks: sessionId ? this.#db.all<{ data: string }>("SELECT data FROM image_tasks WHERE session_id = ? ORDER BY created_at, rowid", sessionId).map((row) => JSON.parse(row.data) as ImageTask) : [],
    };
  }

  /** The newest task with an image owns the session's cover; one pass, newest first. */
  #sessionPreviews(): Map<string, string> {
    const previews = new Map<string, string>();
    for (const row of this.#db.all<{ session_id: string; preview: string | null }>(
      "SELECT session_id, json_extract(data, '$.images[0].path') AS preview FROM image_tasks ORDER BY created_at DESC, rowid DESC",
    )) {
      if (row.preview && !previews.has(row.session_id)) previews.set(row.session_id, row.preview);
    }
    return previews;
  }

  async createSession(title?: string): Promise<ImageSession> {
    this.#ensureOpen();
    const config = await this.getConfig();
    this.#ensureOpen();
    const session = this.#newSession(title, undefined, config.defaultModelId);
    this.#db.transaction(() => { this.#writeSession(session); this.#advanceRevision(); });
    this.#announce(session.id);
    return structuredClone(session);
  }

  async renameSession(id: string, title: string): Promise<void> {
    this.#ensureOpen();
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new Error(uiText("请输入不超过 200 字的会话名称。", "Enter a session name of at most 200 characters."));
    const session = this.#session(id);
    if (!session) throw new Error(uiText("图片会话已不存在。", "The image session no longer exists."));
    this.#db.transaction(() => { this.#writeSession({ ...session, title: title.trim(), updatedAt: Date.now() }); this.#advanceRevision(); });
    this.#announce(id);
  }

  async deleteSession(id: string): Promise<void> {
    this.#ensureOpen();
    const session = this.#session(id);
    if (!session) return;
    this.#deletingSessions.add(id);
    try {
      const tasks = this.#db.all<{ id: string }>("SELECT id FROM image_tasks WHERE session_id = ?", id);
      const jobs = tasks.flatMap((task) => {
        const job = this.#running.get(task.id);
        return job ? [job.done] : [];
      });
      for (const task of tasks) await this.cancel(task.id);
      await Promise.allSettled(jobs);
      this.#ensureOpen();
      // Keep cancelled records available for retry if filesystem cleanup fails.
      await rm(join(this.#root, session.id), { recursive: true, force: true });
      this.#ensureOpen();
      this.#db.transaction(() => { this.#db.run("DELETE FROM image_sessions WHERE id = ?", id); this.#advanceRevision(); });
      for (const task of tasks) this.#wake(task.id);
      this.#announce(id);
    } finally { this.#deletingSessions.delete(id); }
  }

  async deleteTask(taskId: string): Promise<void> {
    this.#ensureOpen();
    const task = this.#task(taskId);
    if (!task) return;
    const job = this.#running.get(taskId);
    await this.cancel(taskId);
    if (job) await Promise.allSettled([job.done]);
    this.#ensureOpen();
    await rm(join(this.#root, task.sessionId, task.id), { recursive: true, force: true });
    this.#ensureOpen();
    this.#db.transaction(() => { this.#db.run("DELETE FROM image_tasks WHERE id = ?", taskId); this.#advanceRevision(); });
    this.#wake(taskId);
    this.#announce(task.sessionId);
  }

  async generate(request: ImageGenerateRequest): Promise<ImageTask> {
    this.#ensureOpen();
    validateRequest(request);
    const config = await this.getConfig();
    this.#ensureOpen();
    const prior = this.#db.get<{ data: string }>("SELECT data FROM image_tasks WHERE request_id = ?", request.requestId);
    if (prior) return JSON.parse(prior.data) as ImageTask;
    let session = request.sessionId ? this.#session(request.sessionId) : undefined;
    if (request.sessionId && !session) throw new Error(uiText("图片会话已不存在。", "The image session no longer exists."));
    if (!session && request.sourceConversationId) {
      session = this.#db.all<{ data: string }>("SELECT data FROM image_sessions ORDER BY updated_at DESC").map((row) => JSON.parse(row.data) as ImageSession).find((item) => item.sourceConversationId === request.sourceConversationId);
    }
    if (session && this.#deletingSessions.has(session.id)) throw new Error(uiText("图片会话正在删除。", "The image session is being deleted."));
    const selected = request.modelId ?? session?.modelId ?? config.defaultModelId;
    const model = config.models.find((item) => item.id === selected && isUsableImageModel(item));
    if (!model) throw new Error(uiText("请先在模型设置中配置并选择可用的默认图片模型。", "Configure and select an available default image model in model settings first."));
    const validated = validateOptions({ ...session?.options, ...request.options });
    const options = model.protocol === "openai" ? normalizeOpenAiOptions(validated, model) : validated;
    session ??= this.#newSession(request.prompt.trim().slice(0, 40), request.sourceConversationId);
    session = { ...session, modelId: model.id, options, updatedAt: Date.now() };
    const task: ImageTask = {
      id: randomUUID(), requestId: request.requestId, sessionId: session.id,
      createdAt: Date.now(), status: "generating", prompt: request.prompt.trim(),
      model: { ...model }, options, references: [], images: [],
    };
    this.#db.transaction(() => { this.#writeSession(session!); this.#writeTask(task); this.#advanceRevision(); });
    const controller = new AbortController();
    // Defer the actual request until the durable acknowledgement has been returned.
    const done = Promise.resolve().then(() => this.#run(task, structuredClone(request.references ?? []), controller.signal)).catch((error: unknown) => {
      console.error("[images] task finalization failed:", error instanceof Error ? error.name : "unknown");
    }).finally(() => { this.#running.delete(task.id); this.#wake(task.id); });
    this.#running.set(task.id, { controller, done });
    this.#announce(session.id);
    return structuredClone(task);
  }

  async cancel(taskId: string): Promise<void> {
    this.#ensureOpen();
    const task = this.#task(taskId);
    if (!task || task.status !== "generating") return;
    // The terminal state wins before the network is cancelled.
    this.#saveTask({ ...task, status: "cancelled", completedAt: Date.now(), error: undefined });
    this.#running.get(taskId)?.controller.abort();
  }

  /** Delivers an immediate durable snapshot, then every saved transition; no polling. */
  subscribeTask(taskId: string, listener: (task: ImageTask) => void): () => void {
    this.#ensureOpen();
    const task = this.#task(taskId);
    if (!task) throw new Error(uiText("图片任务已不存在。", "The image task no longer exists."));
    let listeners = this.#progress.get(taskId);
    if (!listeners) { listeners = new Set(); this.#progress.set(taskId, listeners); }
    listeners.add(listener);
    try { listener(structuredClone(task)); } catch { /* Observers cannot interrupt generation. */ }
    return () => { listeners.delete(listener); if (!listeners.size) this.#progress.delete(taskId); };
  }

  async waitForTask(taskId: string, signal?: AbortSignal): Promise<ImageTask> {
    this.#ensureOpen();
    const read = (): ImageTask => {
      const task = this.#task(taskId);
      if (!task) throw new Error(uiText("图片任务已不存在。", "The image task no longer exists."));
      return task;
    };
    const first = read();
    if (first.status !== "generating") return first;
    if (signal?.aborted) { await this.cancel(taskId); signal.throwIfAborted(); }
    return new Promise<ImageTask>((resolve, reject) => {
      const cleanup = (): void => {
        const listeners = this.#waiters.get(taskId);
        listeners?.delete(check);
        if (!listeners?.size) this.#waiters.delete(taskId);
        signal?.removeEventListener("abort", abort);
      };
      const check = (): void => {
        try {
          const task = read();
          if (task.status === "generating") return;
          cleanup(); resolve(task);
        } catch (error) { cleanup(); reject(error); }
      };
      const abort = (): void => {
        cleanup();
        void this.cancel(taskId).catch(() => undefined);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      let listeners = this.#waiters.get(taskId);
      if (!listeners) { listeners = new Set(); this.#waiters.set(taskId, listeners); }
      listeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    const jobs = [...this.#running.entries()];
    this.#disposePromise = this.#finishDispose(jobs);
    return this.#disposePromise;
  }

  async #finishDispose(jobs: [string, Running][]): Promise<void> {
    for (const [id, job] of jobs) {
      const task = this.#task(id);
      if (task?.status === "generating") this.#saveTask({ ...task, status: "interrupted", completedAt: Date.now(), error: uiText("应用退出，图片生成已中断。", "Image generation was interrupted when the app closed.") });
      job.controller.abort();
    }
    await Promise.allSettled(jobs.map(([, job]) => job.done));
    // The database connection belongs to the process-wide connection cache.
  }

  async #run(task: ImageTask, inputs: ImageReferenceInput[], cancelled: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(5 * 60 * 1000)]);
    const dir = join(this.#root, task.sessionId, task.id);
    let key = "";
    const errors: string[] = [];
    try {
      assertActive(signal);
      key = (task.model.providerId ? await this.#options.resolveProviderKey(task.model.providerId) : undefined) ?? "";
      assertActive(signal);
      if (!key) throw new Error(uiText("图片模型没有可用的 API Key，请在模型设置中配置。", "The image model has no available API key. Configure it in model settings."));
      const references = await prepareReferences(inputs, dir, signal);
      if (!this.#active(task.id)) return;
      const current = this.#task(task.id)!;
      this.#saveTask({ ...current, references: references.map(({ path, name }) => ({ path, name })) });
      // Independent single-image requests: no local waiting queue and no automatic retries.
      await Promise.all(Array.from({ length: task.options.count ?? 1 }, async (_, index) => {
        try {
          const result = await generateProtocolImage({ model: task.model, key, prompt: task.prompt, options: task.options, references, signal, fetch: this.#fetch });
          assertActive(signal);
          if (!this.#active(task.id)) return;
          const image = await saveImage(result.image, dir, index, signal);
          if (!this.#active(task.id)) return;
          const latest = this.#task(task.id)!;
          // Request slots retain their order even when later requests finish first.
          const images = [...latest.images, image].sort((a, b) => basename(a.path).localeCompare(basename(b.path), "en", { numeric: true }));
          this.#saveTask({ ...latest, images, ...(result.text ? { text: result.text } : {}) });
        } catch (error) { errors.push(safeError(error, key)); }
      }));
      if (!this.#active(task.id)) return;
      const latest = this.#task(task.id)!;
      const status = latest.images.length === (task.options.count ?? 1) ? "succeeded" : latest.images.length ? "partial" : "failed";
      this.#saveTask({ ...latest, status, completedAt: Date.now(), ...(errors.length ? { error: [...new Set(errors)].join("\n").slice(0, 1_500) } : {}) });
    } catch (error) {
      if (!this.#active(task.id)) return;
      const latest = this.#task(task.id)!;
      this.#saveTask({ ...latest, status: latest.images.length ? "partial" : "failed", completedAt: Date.now(), error: safeError(error, key) });
    }
  }

  #newSession(title?: string, sourceConversationId?: string, defaultModelId?: string): ImageSession {
    return { id: randomUUID(), title: title?.trim().slice(0, 200) || uiText("新图片会话", "New image session"), createdAt: Date.now(), updatedAt: Date.now(), ...(defaultModelId ? { modelId: defaultModelId } : {}), ...(sourceConversationId ? { sourceConversationId } : {}) };
  }
  #session(id: string): ImageSession | undefined {
    const row = this.#db.get<{ data: string }>("SELECT data FROM image_sessions WHERE id = ?", id);
    return row ? JSON.parse(row.data) as ImageSession : undefined;
  }
  #task(id: string): ImageTask | undefined {
    const row = this.#db.get<{ data: string }>("SELECT data FROM image_tasks WHERE id = ?", id);
    return row ? JSON.parse(row.data) as ImageTask : undefined;
  }
  #active(id: string): boolean { return !this.#disposed && this.#task(id)?.status === "generating"; }
  #writeTask(task: ImageTask): void {
    this.#db.run("INSERT INTO image_tasks (id, request_id, session_id, created_at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", task.id, task.requestId, task.sessionId, task.createdAt, JSON.stringify(task));
  }
  #writeSession(session: ImageSession): void {
    this.#db.run("INSERT INTO image_sessions (id, updated_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data", session.id, session.updatedAt, JSON.stringify(session));
  }
  #saveTask(task: ImageTask): void {
    this.#db.transaction(() => { this.#writeTask(task); this.#advanceRevision(); });
    this.#announce(task.sessionId);
    for (const listener of [...(this.#progress.get(task.id) ?? [])]) {
      try { listener(structuredClone(task)); } catch { /* Observers cannot interrupt durable progress. */ }
    }
    this.#wake(task.id);
  }
  #revision(): number { return Number(this.#db.get<{ value: string }>("SELECT value FROM image_meta WHERE key = 'revision'")?.value ?? 0); }
  #advanceRevision(): void {
    this.#db.run("INSERT INTO image_meta (key, value) VALUES ('revision', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)");
  }
  #changed(): void { this.#db.transaction(() => this.#advanceRevision()); this.#announce(); }
  #announce(sessionId?: string): void {
    try { this.#options.onChanged?.({ revision: this.#revision(), ...(sessionId ? { sessionId } : {}) }); }
    catch { /* A disconnected UI cannot prevent the job's durable progress. */ }
  }
  #wake(id: string): void { for (const listener of [...(this.#waiters.get(id) ?? [])]) listener(); }
  #ensureOpen(): void { if (this.#disposed) throw new Error(uiText("图片生成服务已关闭。", "The image generation service is closed.")); }
}

function validateRequest(request: ImageGenerateRequest): void {
  if (!request || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 200 || typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 32_000) throw new Error(uiText("请填写图片描述，并提供有效的请求标识。", "Enter an image prompt and provide a valid request ID."));
  if ((request.sessionId !== undefined && typeof request.sessionId !== "string") || (request.modelId !== undefined && typeof request.modelId !== "string") || (request.sourceConversationId !== undefined && (typeof request.sourceConversationId !== "string" || request.sourceConversationId.length > 300))) throw new Error(uiText("图片生成请求无效。", "Invalid image generation request."));
  if (request.references !== undefined && (!Array.isArray(request.references) || request.references.length > MAX_REFERENCES || request.references.some((reference) => !reference || typeof reference !== "object"))) throw new Error(uiText("参考图无效，一次最多使用 1 张。", "Invalid reference image. Use at most one image."));
  for (const reference of request.references ?? []) {
    if ("data" in reference && (typeof reference.data !== "string" || reference.data.length > Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 || typeof reference.mimeType !== "string" || typeof reference.name !== "string")) throw new Error(uiText("参考图内容无效或超过 12 MiB。", "The reference image is invalid or exceeds 12 MiB."));
    if ("path" in reference && (typeof reference.path !== "string" || reference.path.length > 16_384)) throw new Error(uiText("参考图路径无效。", "Invalid reference image path."));
  }
}

function validateOptions(options: ImageOptions): ImageOptions {
  const count = options.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error(uiText("一次可生成 1 至 4 张图片。", "Generate between one and four images at a time."));
  for (const field of ["aspectRatio", "size", "quality"] as const) {
    if (options[field] !== undefined && (typeof options[field] !== "string" || options[field]!.length > 40 || /[\r\n]/.test(options[field]!))) throw new Error(uiText("图片生成参数无效。", "Invalid image generation options."));
  }
  return { count, ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}), ...(options.size ? { size: options.size } : {}), ...(options.quality ? { quality: options.quality } : {}) };
}

function safeError(error: unknown, key: string): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return uiText("图片生成已超时或中断，请核对结果后重试。", "Image generation timed out or was interrupted. Check the result before retrying.");
  if (error instanceof Error && "code" in error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return uiText("参考图已不存在，请重新添加。", "A reference image is missing. Add it again.");
    if (error.code === "EACCES" || error.code === "EPERM") return uiText("无法读取或保存图片，请检查文件访问权限。", "Could not read or save the image. Check file access permissions.");
  }
  if (error instanceof TypeError && error.message === "fetch failed") return uiText("无法连接图片服务，请检查网络和服务地址。", "Could not connect to the image service. Check the network and service URL.");
  const message = error instanceof Error ? error.message : uiText("图片生成失败，请稍后重试。", "Image generation failed. Try again later.");
  return redact(message, key).slice(0, 700);
}
