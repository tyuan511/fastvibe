import { randomUUID } from "node:crypto";
// Extension spelled out, like `src/main/server/*`, so `node --test` can resolve the
// chain without the Vite aliases: the catalog's change notice is what every client's
// conversation list rides on, and that deserves a test that loads the real module.
import { uiText } from "./ui-text.ts";
import { ensureScratchWorkspace, scratchWorkspace } from "./paths.ts";
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Conversation, Project, WorkspaceSnapshot } from "@shared/types";

type CatalogFile = {
  /** v1 stored the project binding in `cwd`; v2 splits `project` from the engine `cwd`. */
  version: 2;
  activeId?: string;
  projects: Project[];
  conversations: Conversation[];
};

export class ConversationCatalog {
  #file: string;
  #scratchRoot: string;
  #projects: Project[] = [];
  #items: Conversation[] = [];
  #activeId: string | undefined;
  #writeTimer: NodeJS.Timeout | null = null;
  /**
   * Told after every change, with the snapshot as it now stands.
   *
   * Set after construction rather than taken as a constructor argument, because
   * `#read()` migrates older files and writes during construction — announcing a
   * snapshot before the object exists is a push nothing could have subscribed to.
   */
  onChange: ((snapshot: WorkspaceSnapshot) => void) | null = null;

  constructor(file: string, scratchRoot: string) {
    this.#file = file;
    this.#scratchRoot = scratchRoot;
    this.#read();
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
    if (this.#activeId === id) return;
    this.#activeId = id;
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
    options?: { activate?: boolean; kind?: Conversation["kind"]; title?: string; parentId?: string; preview?: string },
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

  #read(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        // v0: a bare array; every non-empty cwd was a project.
        this.#items = parsed.filter(isConversation).map((item) => this.#migrateLegacy(item));
        this.#projects = projectsFromConversations(this.#items).sort(byProjectCreatedDesc);
        this.#activeId = this.#items[0]?.id;
        this.#isolateScratch();
        this.#write();
        return;
      }
      if (isRecord(parsed) && typeof parsed.version === "number") {
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
          withProjectCreatedAt(item, this.#items),
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
        const scratchMigrated = this.#isolateScratch();
        if (legacy || needsProjectMigration || scratchMigrated) this.#write();
        return;
      }
    } catch {
      // empty catalog
    }
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
   * Coalesce writes: a single user action (e.g. switching project) mutates the
   * catalog several times, and each `writeFileSync` blocked the main process and
   * the UI. Callers only read the in-memory state, so a short debounce is safe.
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
   * Write, and say what changed.
   *
   * The announcement rides the same funnel as the disk write, which is the point. Every
   * mutation above calls `#write()`, so this is the one place that knows the catalog
   * moved — and the 40ms debounce that exists to coalesce the `writeFileSync` coalesces
   * the push for free: one notice per user action rather than one per mutation, of which
   * a single "switch project" makes several.
   *
   * Announcing *after* the write means a client that re-reads in response cannot see a
   * state older than the one on disk.
   */
  #flush(): void {
    const payload: CatalogFile = {
      version: 2,
      activeId: this.#activeId,
      projects: this.#projects,
      conversations: this.#items,
    };
    writeFileSync(this.#file, `${JSON.stringify(payload, null, 2)}\n`);
    this.onChange?.(this.snapshot());
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
