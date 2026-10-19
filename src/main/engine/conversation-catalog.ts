import { randomUUID } from "node:crypto";
// Extension spelled out, like `src/main/server/*`, so `node --test` can resolve the
// chain without the Vite aliases: the catalog's change notice is what every client's
// conversation list rides on, and that deserves a test that loads the real module.
import { uiText } from "./ui-text.ts";
import { ensureScratchWorkspace, scratchWorkspace } from "./paths.ts";
import { readdirSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { importLegacyJson, RowWriter, type Db } from "./db.ts";
import { extraFolders } from "../../shared/project-folders.ts";
import type { Conversation, Project, WorkspaceSnapshot } from "@shared/types";

/** A project row is the object plus where it sits in the sidebar's drag order. */
type ProjectRow = { project: Project; position: number };

export class ConversationCatalog {
  #db: Db;
  #scratchRoot: string;
  #projects: Project[] = [];
  #items: Conversation[] = [];
  #activeId: string | undefined;
  #writeTimer: NodeJS.Timeout | null = null;
  #conversations: RowWriter<Conversation>;
  #projectRows: RowWriter<ProjectRow>;
  /** What `catalog_meta` holds for `activeId`; `null` is the absence of a row. */
  #activeIdStored: string | null = null;
  /**
   * Every conversation id and project folder this process has held. A flush adopts rows
   * another process added that are not in here, and must not adopt one that is in here and
   * no longer in memory — that is a delete this process made, and adopting it back would
   * resurrect a chat the user removed.
   */
  #knownIds = new Set<string>();
  #knownProjects = new Set<string>();
  /**
   * Told after every change, with the snapshot as it now stands.
   *
   * Set after construction rather than taken as a constructor argument, because
   * it is assigned after construction rather than taken as a constructor argument,
   * because announcing a snapshot before the object exists is a push nothing could have
   * subscribed to — and because the one-time import of the old JSON can itself flush.
   */
  onChange: ((snapshot: WorkspaceSnapshot) => void) | null = null;

  constructor(db: Db, options: { scratchRoot: string; legacyFile?: string }) {
    this.#db = db;
    this.#scratchRoot = options.scratchRoot;
    this.#conversations = new RowWriter<Conversation>(db, {
      table: "conversations",
      identity: (item) => ({ id: item.id }),
      columns: (item) => ({
        project: item.project,
        kind: item.kind,
        parent_id: item.parentId,
        session_id: item.sessionId,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      }),
      data: (item) => JSON.stringify(item),
    });
    this.#projectRows = new RowWriter<ProjectRow>(db, {
      table: "projects",
      identity: (row) => ({ cwd: row.project.cwd }),
      columns: (row) => ({ position: row.position }),
      data: (row) => JSON.stringify(row.project),
    });

    // The old file, once, in this store's own reading code. Whether it was v0 or v1 or v2
    // decides the project backfill and the scratch-directory isolation — work that has to
    // happen before any row exists, and which must not be redone for a database that has
    // already answered it.
    let imported = false;
    if (options.legacyFile) {
      imported =
        importLegacyJson(db, {
          name: "catalog",
          file: options.legacyFile,
          load: (value) => {
            this.#readLegacy(value);
            return true;
          },
          save: () => {
            this.#writeRows();
            return this.#items.length + this.#projects.length + 1;
          },
          count: () =>
            db.countRows("conversations") + db.countRows("projects") + db.countRows("catalog_meta"),
        }) === "imported";
    }
    if (!imported) this.#readTables();
    this.#noteKnown();
  }

  snapshot(): WorkspaceSnapshot {
    return {
      projects: this.listProjects(),
      conversations: this.list(),
      activeId: this.#activeId,
    };
  }

  list(): Conversation[] {
    return this.#items.filter((item) => item.kind !== "side-chat").sort(byCreatedDesc);
  }

  listAll(): Conversation[] {
    return [...this.#items].sort(byCreatedDesc);
  }

  /** Drop auxiliary chats that have no open tab (they are not shown in the tree). */
  takeSideChats(): Conversation[] {
    const removed = this.#items.filter((item) => item.kind === "side-chat");
    if (removed.length === 0) return [];
    const ids = new Set(removed.map((item) => item.id));
    this.#items = this.#items.filter((item) => !ids.has(item.id));
    if (this.#activeId && ids.has(this.#activeId)) {
      this.#activeId = this.#items[0]?.id;
    }
    this.#write();
    return removed;
  }

  /**
   * Projects in the order the sidebar shows them: newest added first, unless the
   * user dragged them around, in which case the stored array order wins.
   * Never sorted by `updatedAt` — activity in a project must not move it.
   */
  listProjects(): Project[] {
    return [...this.#projects];
  }

  get(id: string): Conversation | undefined {
    return this.#items.find((item) => item.id === id);
  }

  /** The one unfinished conversation reserved for a project, if it exists. */
  findEmpty(project?: string | null): Conversation | undefined {
    const bound = normalizeProject(project);
    return this.#items.find((item) => item.kind !== "side-chat" && !item.preview && item.project === bound);
  }

  get activeId(): string | undefined {
    return this.#activeId;
  }

  setActive(id: string | undefined): void {
    // Opening a chat *is* reading it, so the mark that says 「a reply landed while you
    // were on another one」 ends here — including the case where the chat was already
    // active and only the mark needs clearing.
    const opened = id ? this.#items.find((item) => item.id === id) : undefined;
    const read = opened?.unread === true;
    if (read && opened) delete opened.unread;
    if (this.#activeId === id && !read) return;
    this.#activeId = id;
    this.#write();
  }

  /**
   * Say that a finished reply in this chat has not been read yet. See `Conversation.unread`.
   *
   * Deliberately not `update()`: that stamps `updatedAt`, which is what 设置 → 归档对话
   * shows as 更新时间 and what the auto-archive sweep waits on. Being slow to look at a
   * chat that finished is not a mutation *of* the chat, and it must not push it out of
   * both of those windows.
   */
  markUnread(id: string): void {
    const item = this.#items.find((entry) => entry.id === id);
    if (!item || item.kind === "side-chat" || item.unread === true) return;
    item.unread = true;
    this.#write();
  }

  ensureProject(cwd: string): Project | undefined {
    const path = cwd.trim();
    if (!path) return undefined;
    const existing = this.#projects.find((item) => item.cwd === path);
    if (existing) {
      existing.updatedAt = Date.now();
      this.#write();
      return existing;
    }
    const project: Project = {
      cwd: path,
      name: basename(path) || path,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#projects = [project, ...this.#projects];
    this.#write();
    return project;
  }

  /**
   * Create a project whose first folder is primary. An existing project with that
   * primary folder gains the extra folders instead of being duplicated.
   */
  createProject(folders: string[], name?: string): Project | undefined {
    const paths = folders.map((item) => item.trim()).filter(Boolean);
    const primary = paths[0];
    if (!primary) return undefined;
    const existing = this.#projects.find((item) => item.cwd === primary);
    if (existing) {
      const next = extraFolders(primary, [...(existing.folders ?? []), ...paths.slice(1)]);
      if (next) existing.folders = next;
      const trimmed = name?.trim();
      if (trimmed) existing.name = trimmed;
      existing.updatedAt = Date.now();
      this.#write();
      return existing;
    }
    const extras = extraFolders(primary, paths.slice(1));
    const project: Project = {
      cwd: primary,
      name: name?.trim() || basename(primary) || primary,
      ...(extras ? { folders: extras } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#projects = [project, ...this.#projects];
    this.#write();
    return project;
  }

  addProjectFolder(cwd: string, folder: string): Project | undefined {
    const project = this.#projects.find((item) => item.cwd === cwd);
    if (!project || project.kind === "remote") return undefined;
    const path = folder.trim();
    if (!path || path === project.cwd) return project;
    project.folders = extraFolders(project.cwd, [...(project.folders ?? []), path]);
    project.updatedAt = Date.now();
    this.#write();
    return project;
  }

  removeProjectFolder(cwd: string, folder: string): Project | undefined {
    const project = this.#projects.find((item) => item.cwd === cwd);
    if (!project || project.kind === "remote") return undefined;
    if (!folder || folder === project.cwd) return undefined;
    const next = extraFolders(project.cwd, (project.folders ?? []).filter((item) => item !== folder));
    if (next) project.folders = next;
    else delete project.folders;
    project.updatedAt = Date.now();
    this.#write();
    return project;
  }

  /**
   * Make `folder` the primary folder. That changes the project's identity (`cwd`)
   * and every conversation bound to it. Existing conversation working directories
   * stay where they are; only new chats use the new primary folder.
   */
  setProjectPrimary(cwd: string, folder: string): { project: Project; previous: string } | undefined {
    const project = this.#projects.find((item) => item.cwd === cwd);
    if (!project || project.kind === "remote") return undefined;
    const next = folder.trim();
    if (!next) return undefined;
    if (next === cwd) return { project, previous: cwd };
    const known = new Set([project.cwd, ...(project.folders ?? [])]);
    if (!known.has(next)) return undefined;
    const previous = project.cwd;
    const rest = extraFolders(next, [previous, ...(project.folders ?? [])]);
    project.cwd = next;
    if (rest) project.folders = rest;
    else delete project.folders;
    if (project.name === (basename(previous) || previous)) project.name = basename(next) || next;
    project.updatedAt = Date.now();
    for (const item of this.#items) {
      if (item.project === previous) item.project = next;
    }
    this.#write();
    return { project, previous };
  }

  /**
   * Persist a drag-reordered project list. Unknown cwds are ignored and any project
   * the renderer omitted keeps its relative position at the end, so a stale drag
   * can never drop a project.
   */
  reorderProjects(cwds: string[]): Project[] {
    const rank = new Map<string, number>();
    cwds.forEach((cwd, index) => rank.set(cwd, index));
    this.#projects = [...this.#projects].sort((a, b) => {
      const left = rank.get(a.cwd);
      const right = rank.get(b.cwd);
      if (left === undefined && right === undefined) return 0;
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return left - right;
    });
    this.#write();
    return this.listProjects();
  }

  renameProject(cwd: string, name: string): Project | undefined {
    const project = this.#projects.find((item) => item.cwd === cwd);
    if (!project) return undefined;
    const trimmed = name.trim();
    if (!trimmed) return project;
    project.name = trimmed;
    project.updatedAt = Date.now();
    this.#write();
    return project;
  }

  removeProject(cwd: string): Conversation[] {
    const removed = this.#items.filter((item) => item.project === cwd);
    this.#items = this.#items.filter((item) => item.project !== cwd);
    this.#projects = this.#projects.filter((item) => item.cwd !== cwd);
    if (this.#activeId && removed.some((item) => item.id === this.#activeId)) {
      this.#activeId = this.#items[0]?.id;
    }
    this.#write();
    return removed;
  }

  create(
    project: string | undefined,
    session?: { sessionFile?: string; sessionId?: string; cwd?: string; worktree?: { path: string; branch: string } },
    options?: { activate?: boolean; kind?: Conversation["kind"]; title?: string; parentId?: string; preview?: string; scheduledTaskId?: string },
  ): Conversation {
    const id = session?.sessionId || randomUUID();
    const bound = normalizeProject(project);
    if (bound) this.ensureProject(bound);
    const now = Date.now();
    const conversation = this.#assignCwd({
      id,
      title: options?.title?.trim() || uiText("新会话", "New chat"),
      cwd: session?.cwd ?? bound ?? "",
      project: bound,
      sessionFile: session?.sessionFile,
      sessionId: session?.sessionId,
      worktree: session?.worktree,
      createdAt: now,
      updatedAt: now,
      kind: options?.kind,
      parentId: options?.parentId,
      scheduledTaskId: options?.scheduledTaskId,
      preview: options?.preview?.trim() || (options?.kind === "side-chat" ? options.title?.trim() || uiText("辅助对话", "Side chat") : undefined),
    });
    this.#items = [conversation, ...this.#items.filter((item) => item.id !== conversation.id)];
    if (options?.activate !== false) this.#activeId = conversation.id;
    this.#write();
    return conversation;
  }

  /** Bind or unbind a conversation to a project, keeping `cwd` in sync. */
  setProject(id: string, project: string | undefined): Conversation | undefined {
    const bound = normalizeProject(project);
    if (bound) this.ensureProject(bound);
    return this.update(id, { project: bound, cwd: bound ?? this.#scratchFor(id), worktree: undefined });
  }

  /** Point the engine cwd at a git worktree, or restore it to the bound project. */
  setWorktree(id: string, worktree: { path: string; branch: string } | undefined, project?: string): Conversation | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const bound = normalizeProject(project) ?? current.project;
    if (bound) this.ensureProject(bound);
    if (worktree) {
      return this.update(id, { project: bound, cwd: worktree.path, worktree });
    }
    return this.update(id, { project: bound, cwd: bound ?? this.#scratchFor(id), worktree: undefined });
  }

  /** Restore a prompt preview only if no later catalog mutation replaced it. */
  restorePromptPreview(
    id: string,
    expected: { title: string; preview?: string },
    previous: { title: string; preview?: string },
  ): boolean {
    const current = this.get(id);
    if (!current || current.title !== expected.title || current.preview !== expected.preview) return false;
    this.update(id, { title: previous.title, preview: previous.preview });
    return true;
  }

  update(id: string, patch: Partial<Conversation>): Conversation | undefined {
    const index = this.#items.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const current = this.#items[index];
    // `createdAt` is immutable: it is the sidebar's sort key.
    const next: Conversation = {
      ...current,
      ...patch,
      id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    };
    if ("project" in patch) {
      next.project = normalizeProject(patch.project);
      // An explicit cwd wins: binding a worktree sets `project` *and* a checkout that
      // is not the project path. Only fill cwd from the project when the caller left it alone.
      if (!("cwd" in patch)) next.cwd = next.project ?? "";
    }
    const assigned = this.#assignCwd(next);
    this.#items[index] = assigned;
    if (assigned.project) this.ensureProject(assigned.project);
    this.#write();
    return assigned;
  }

  remove(id: string): Conversation | undefined {
    const found = this.#items.find((item) => item.id === id);
    if (!found) return undefined;
    this.#items = this.#items.filter((item) => item.id !== id);
    if (this.#activeId === id) {
      const sibling = this.#items.find((item) => item.project === found.project);
      this.#activeId = sibling?.id ?? this.#items[0]?.id;
    }
    this.#write();
    return found;
  }

  touchFromEngine(project: string | undefined, session?: { sessionFile?: string; sessionId?: string }): Conversation {
    if (session?.sessionId) {
      const existing = this.#items.find((item) => item.sessionId === session.sessionId);
      if (existing) {
        return this.update(existing.id, {
          project: normalizeProject(project) ?? existing.project,
          sessionFile: session.sessionFile ?? existing.sessionFile,
        })!;
      }
    }
    return this.create(project, session);
  }

  /**
   * The legacy `conversations.json`, read into memory. Everything below is the migration
   * this file has always needed; it runs only inside the one-time import.
   */
  #readLegacy(parsed: unknown): void {
    if (Array.isArray(parsed)) {
      // v0: a bare array; every non-empty cwd was a project.
      this.#items = parsed.filter(isConversation).map((item) => this.#migrateLegacy(item));
      this.#projects = projectsFromConversations(this.#items).sort(byProjectCreatedDesc);
      this.#activeId = this.#items[0]?.id;
      this.#isolateScratch();
      return;
    }
    if (!isRecord(parsed) || typeof parsed.version !== "number") {
      // Not a catalog this file format ever wrote. The import counts it as answered and
      // the store starts empty, which is what reading this file used to end up with.
      return;
    }
    const legacy = parsed.version < 2;
    const rawItems = (Array.isArray(parsed.conversations) ? parsed.conversations : []).filter(isConversation);
    // Catalogs written before `createdAt` existed fall back to `updatedAt`,
    // which is the best available proxy for creation order.
    this.#items = legacy ? rawItems.map((item) => this.#migrateLegacy(item)) : rawItems.map(withCreatedAt);
    // Projects written before `createdAt` existed were displayed by activity, not
    // by add time, so their stored order is not the user's order: backfill the
    // timestamp and restore newest-added-first once. A catalog that already
    // carries `createdAt` keeps its stored order, which is the drag order.
    const storedProjects = Array.isArray(parsed.projects) ? parsed.projects.filter(isProject) : null;
    const needsProjectMigration = storedProjects ? storedProjects.some((item) => !hasCreatedAt(item)) : true;
    this.#projects = (storedProjects ?? projectsFromConversations(this.#items)).map((item) =>
      sanitizeProjectFolders(withProjectCreatedAt(item, this.#items)),
    );
    for (const item of this.#items) {
      if (item.project && !this.#projects.some((project) => project.cwd === item.project)) {
        this.#projects.push({
          cwd: item.project,
          name: basename(item.project) || item.project,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        });
      }
    }
    if (needsProjectMigration) this.#projects.sort(byProjectCreatedDesc);
    this.#activeId = typeof parsed.activeId === "string" ? parsed.activeId : this.#items[0]?.id;
    // One chat per scratch directory: a filesystem migration, so it belongs to the file it
    // came from and runs exactly once, inside this import.
    this.#isolateScratch();
  }

  /** `scratch/<id>`, created on disk so the engine can use it as a cwd. */
  #scratchFor(id: string): string {
    return ensureScratchWorkspace(this.#scratchRoot, id);
  }

  /** True when `cwd` is missing or is the shared scratch root every chat used to share. */
  #isSharedScratch(cwd: string | undefined): boolean {
    if (!cwd?.trim()) return true;
    return resolve(cwd) === resolve(this.#scratchRoot);
  }

  /**
   * Keep an explicit workspace, and send an unbound chat to its own scratch directory.
   *
   * A path equal to the scratch root is not an explicit workspace: that is the old
   * shared directory. A bound project wins over it, including when the project path
   * itself is that root.
   */
  #assignCwd(conversation: Conversation): Conversation {
    if (conversation.worktree) return { ...conversation, cwd: conversation.worktree.path };
    if (conversation.project) {
      const cwd = conversation.cwd && !this.#isSharedScratch(conversation.cwd) ? conversation.cwd : conversation.project;
      return { ...conversation, cwd };
    }
    if (!conversation.cwd || this.#isSharedScratch(conversation.cwd)) {
      return { ...conversation, cwd: this.#scratchFor(conversation.id) };
    }
    return conversation;
  }

  /**
   * Give every unbound chat that still points at the shared scratch root its own
   * `scratch/<id>`. A side chat follows its parent: it was opened to work in that
   * same directory, not to start a second one.
   *
   * Files already in the shared root move only when a single chat owns them. Several
   * chats writing into one directory leave no record of which file was whose, and
   * guessing would hide work from the rest — those files stay where they are.
   */
  #isolateScratch(): boolean {
    const shared = this.#items.filter((item) => !item.project && !item.worktree && this.#isSharedScratch(item.cwd));
    if (shared.length === 0) return false;
    const owners = shared.filter((item) => item.kind !== "side-chat");
    if (owners.length === 1) this.#adoptSharedScratch(owners[0].id);
    const byId = new Map(this.#items.map((item) => [item.id, item]));
    this.#items = this.#items.map((item) => {
      if (item.project || item.worktree || !this.#isSharedScratch(item.cwd)) return item;
      if (item.kind === "side-chat" && item.parentId) {
        const parent = byId.get(item.parentId);
        if (parent && !parent.project && !parent.worktree) return { ...item, cwd: this.#scratchFor(parent.id) };
        if (parent?.cwd && !this.#isSharedScratch(parent.cwd)) return { ...item, cwd: parent.cwd };
      }
      return { ...item, cwd: this.#scratchFor(item.id) };
    });
    return true;
  }

  /** Move the shared root's entries into one chat's directory. Other chats' directories are left alone. */
  #adoptSharedScratch(id: string): void {
    const dest = this.#scratchFor(id);
    const reserved = new Set(this.#items.map((item) => basename(scratchWorkspace(this.#scratchRoot, item.id))));
    let names: string[];
    try {
      names = readdirSync(this.#scratchRoot);
    } catch {
      return;
    }
    const destName = basename(dest);
    for (const name of names) {
      if (name === destName || reserved.has(name)) continue;
      try {
        renameSync(join(this.#scratchRoot, name), join(dest, name));
      } catch {
        // A file that cannot be moved stays in the shared root. The chat still gets
        // its own directory; leaving the file is safer than failing startup.
      }
    }
  }

  /**
   * v1 kept the project binding in `cwd`, so a non-empty value was a project and an
   * empty one meant unbound. Give unbound conversations a scratch workspace.
   */
  #migrateLegacy(item: Conversation): Conversation {
    const legacyProject = normalizeProject(item.cwd);
    return withCreatedAt({
      ...item,
      project: legacyProject,
      cwd: legacyProject ?? this.#scratchRoot,
    });
  }

  /**
   * Coalesce writes: a single user action (e.g. switching project) mutates the catalog
   * several times, and each write blocked the main process and the UI. Callers only read
   * the in-memory state, so a short debounce is safe — it costs a row-level diff instead
   * of a whole-file serialize, but still one transaction per action, not per mutation.
   */
  #write(): void {
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.#flush();
    }, 40);
    this.#writeTimer.unref?.();
  }

  /** Persist immediately (used on shutdown so a pending debounce is not lost). */
  flush(): void {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    this.#flush();
  }

  /**
   * Write the rows, and say what changed.
   *
   * The announcement rides the same funnel as the write, which is the point. Every mutation
   * above calls `#write()`, so this is the one place that knows the catalog moved — and the
   * 40ms debounce that coalesces the write coalesces the push for free: one notice per user
   * action rather than one per mutation, of which a single "switch project" makes several.
   *
   * Announcing *after* the write means a client that re-reads in response cannot see a state
   * older than the one the database holds.
   */
  #flush(): void {
    try {
      this.#db.transaction(() => {
        this.#adoptFromTable();
        this.#writeRows();
      });
    } catch (error) {
      // A busy or damaged database must not take a chat switch down with it; the in-memory
      // catalog is what every client is being told about, and the next flush retries.
      console.warn(`[catalog] flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.onChange?.(this.snapshot());
  }

  /** The rows themselves, in one transaction: what changed, and what is gone. */
  #writeRows(): void {
    this.#conversations.write(this.#items);
    this.#projectRows.write(this.#projects.map((project, position) => ({ project, position })));
    this.#writeActiveId();
  }

  /**
   * Load the catalog out of the tables, and remember what is already stored.
   *
   * Priming the writers is what makes the next flush write nothing: a store that has just
   * read every row has no reason to hand the same bytes back.
   */
  #readTables(): void {
    this.#items = [];
    this.#projects = [];
    for (const row of this.#db.all<{ data: string }>(
      "SELECT data FROM conversations ORDER BY created_at DESC, id",
    )) {
      const item = this.#parseConversation(row.data);
      if (!item) continue;
      this.#items.push(item);
      this.#conversations.prime(item, row.data);
    }
    let position = 0;
    for (const row of this.#db.all<{ data: string }>("SELECT data FROM projects ORDER BY position, cwd")) {
      const project = this.#parseProject(row.data);
      if (!project) continue;
      this.#projects.push(project);
      this.#projectRows.prime({ project, position }, row.data);
      position += 1;
    }
    this.#activeIdStored = this.#db.get<{ value: string }>("SELECT value FROM catalog_meta WHERE key = 'activeId'")?.value ?? null;
    // An absent row is a catalog that never recorded one — the same 「fall back to the newest
    // chat」 the file reader did. An empty value is the opposite: 没有人打开任何会话.
    this.#activeId = this.#activeIdStored === null ? this.#items[0]?.id : this.#activeIdStored || undefined;
  }

  /**
   * Take in conversations and projects another process wrote since this one last looked.
   *
   * This is what `#adoptFromDisk` used to be, and the reason it still exists: two processes
   * on one data directory (the installed app next to a `pnpm dev`, which may skip the
   * single-instance lock) each hold the catalog in memory. Reading the table is now a
   * `SELECT` of the ids this process has never seen instead of a re-parse of the whole file,
   * and — unlike the file — the rows are compared one by one on write, so a chat the other
   * process deleted stays deleted rather than being rewritten from this one's memory.
   *
   * A chat both processes still hold is last-writer-wins on that row, as it was on the file.
   */
  #adoptFromTable(): void {
    this.#noteKnown();
    const have = new Set(this.#items.map((item) => item.id));
    for (const row of this.#db.all<{ id: string; data: string }>(
      "SELECT id, data FROM conversations ORDER BY created_at DESC, id",
    )) {
      if (this.#knownIds.has(row.id) || have.has(row.id)) continue;
      const item = this.#parseConversation(row.data);
      if (!item) continue;
      this.#items.push(item);
      have.add(row.id);
      this.#conversations.prime(item, row.data);
    }
    const haveProjects = new Set(this.#projects.map((project) => project.cwd));
    let position = this.#projects.length;
    for (const row of this.#db.all<{ cwd: string; data: string }>(
      "SELECT cwd, data FROM projects ORDER BY position, cwd",
    )) {
      if (this.#knownProjects.has(row.cwd) || haveProjects.has(row.cwd)) continue;
      const project = this.#parseProject(row.data);
      if (!project) continue;
      this.#projects.push(project);
      haveProjects.add(row.cwd);
      this.#projectRows.prime({ project, position }, row.data);
      position += 1;
    }
    this.#noteKnown();
  }

  #writeActiveId(): void {
    // `""` means "no conversation is open", which is a state worth storing: the row being
    // absent instead would make the next read fall back to the newest chat.
    const value = this.#activeId ?? "";
    if (value === this.#activeIdStored) return;
    this.#db.run(
      "INSERT INTO catalog_meta (key, value) VALUES ('activeId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      value,
    );
    this.#activeIdStored = value;
  }

  /** A row's JSON, with the same guards the file reader had: a bad row is not a chat. */
  #parseConversation(data: string): Conversation | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return undefined;
    }
    return isConversation(parsed) ? withCreatedAt(parsed) : undefined;
  }

  #parseProject(data: string): Project | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return undefined;
    }
    if (!isProject(parsed)) return undefined;
    return sanitizeProjectFolders(withProjectCreatedAt(parsed, this.#items));
  }

  #noteKnown(): void {
    for (const item of this.#items) this.#knownIds.add(item.id);
    for (const project of this.#projects) this.#knownProjects.add(project.cwd);
  }
}

function projectsFromConversations(conversations: Conversation[]): Project[] {
  const map = new Map<string, Project>();
  for (const item of conversations) {
    const project = item.project;
    if (!project) continue;
    const existing = map.get(project);
    // The oldest chat in a project is the best available proxy for when it was added.
    if (!existing) {
      map.set(project, {
        cwd: project,
        name: basename(project) || project,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
      continue;
    }
    existing.createdAt = Math.min(existing.createdAt, item.createdAt);
    existing.updatedAt = Math.max(existing.updatedAt, item.updatedAt);
  }
  return [...map.values()];
}

function hasCreatedAt(project: Project): boolean {
  return typeof project.createdAt === "number";
}

/** Drop a primary path or duplicates that an older write may have stored. */
function sanitizeProjectFolders(project: Project): Project {
  const folders = extraFolders(project.cwd, project.folders);
  if (folders) project.folders = folders;
  else delete project.folders;
  return project;
}

/** Backfill `createdAt` on projects persisted before the field existed. */
function withProjectCreatedAt(project: Project, conversations: Conversation[]): Project {
  if (hasCreatedAt(project)) return project;
  const earliest = conversations
    .filter((item) => item.project === project.cwd)
    .reduce<number | undefined>((min, item) => (min === undefined || item.createdAt < min ? item.createdAt : min), undefined);
  return { ...project, createdAt: earliest ?? project.updatedAt };
}

/** Newest-added first, with a stable cwd tiebreak for same-millisecond adds. */
function byProjectCreatedDesc(a: Project, b: Project): number {
  return b.createdAt - a.createdAt || a.cwd.localeCompare(b.cwd);
}

function normalizeProject(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Newest-created first, with a stable id tiebreak for same-millisecond creates. */
function byCreatedDesc(a: Conversation, b: Conversation): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/** Backfill `createdAt` on catalogs persisted before the field existed. */
function withCreatedAt(item: Conversation): Conversation {
  if (typeof item.createdAt === "number") return item;
  return { ...item, createdAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now() };
}

function isConversation(value: unknown): value is Conversation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.cwd === "string"
  );
}

function isProject(value: unknown): value is Project {
  return isRecord(value) && typeof value.cwd === "string" && typeof value.name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
