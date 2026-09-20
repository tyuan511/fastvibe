import { randomUUID } from "node:crypto";
// Extension spelled out, like `src/main/server/*`, so `node --test` can resolve the
// chain without the Vite aliases: the catalog's change notice is what every client's
// conversation list rides on, and that deserves a test that loads the real module.
import { uiText } from "./ui-text.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
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
    const conversation: Conversation = {
      id,
      title: options?.title?.trim() || uiText("新会话", "New chat"),
      cwd: session?.cwd ?? bound ?? this.#scratchRoot,
      project: bound,
      sessionFile: session?.sessionFile,
      sessionId: session?.sessionId,
      worktree: session?.worktree,
      createdAt: now,
      updatedAt: now,
      kind: options?.kind,
      parentId: options?.parentId,
      preview: options?.preview?.trim() || (options?.kind === "side-chat" ? options.title?.trim() || uiText("辅助对话", "Side chat") : undefined),
    };
    this.#items = [conversation, ...this.#items.filter((item) => item.id !== conversation.id)];
    if (options?.activate !== false) this.#activeId = conversation.id;
    this.#write();
    return conversation;
  }

  /** Bind or unbind a conversation to a project, keeping `cwd` in sync. */
  setProject(id: string, project: string | undefined): Conversation | undefined {
    const bound = normalizeProject(project);
    if (bound) this.ensureProject(bound);
    return this.update(id, { project: bound, cwd: bound ?? this.#scratchRoot });
  }

  update(id: string, patch: Partial<Conversation>): Conversation | undefined {
    const index = this.#items.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const current = this.#items[index];
    // `createdAt` is immutable: it is the sidebar's sort key.
    const next = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt: Date.now() };
    if ("project" in patch) {
      next.project = normalizeProject(patch.project);
      next.cwd = next.project ?? this.#scratchRoot;
    } else if (!next.cwd) {
      next.cwd = next.project ?? this.#scratchRoot;
    }
    this.#items[index] = next;
    if (next.project) this.ensureProject(next.project);
    this.#write();
    return next;
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
        if (legacy || needsProjectMigration) this.#write();
        return;
      }
    } catch {
      // empty catalog
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
