import { randomUUID } from "node:crypto";
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
    return [...this.#items].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listProjects(): Project[] {
    return [...this.#projects].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Conversation | undefined {
    return this.#items.find((item) => item.id === id);
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
      updatedAt: Date.now(),
    };
    this.#projects = [project, ...this.#projects];
    this.#write();
    return project;
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

  create(project: string | undefined, session?: { sessionFile?: string; sessionId?: string }): Conversation {
    const id = session?.sessionId || randomUUID();
    const bound = normalizeProject(project);
    if (bound) this.ensureProject(bound);
    const conversation: Conversation = {
      id,
      title: "新会话",
      cwd: bound ?? this.#scratchRoot,
      project: bound,
      sessionFile: session?.sessionFile,
      sessionId: session?.sessionId,
      updatedAt: Date.now(),
    };
    this.#items = [conversation, ...this.#items.filter((item) => item.id !== conversation.id)];
    this.#activeId = conversation.id;
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
    const next = { ...current, ...patch, id, updatedAt: Date.now() };
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
        this.#projects = projectsFromConversations(this.#items);
        this.#activeId = this.#items[0]?.id;
        this.#write();
        return;
      }
      if (isRecord(parsed) && typeof parsed.version === "number") {
        const legacy = parsed.version < 2;
        const rawItems = (Array.isArray(parsed.conversations) ? parsed.conversations : []).filter(isConversation);
        this.#items = legacy ? rawItems.map((item) => this.#migrateLegacy(item)) : rawItems;
        this.#projects = Array.isArray(parsed.projects)
          ? parsed.projects.filter(isProject)
          : projectsFromConversations(this.#items);
        for (const item of this.#items) {
          if (item.project && !this.#projects.some((project) => project.cwd === item.project)) {
            this.#projects.push({
              cwd: item.project,
              name: basename(item.project) || item.project,
              updatedAt: item.updatedAt,
            });
          }
        }
        this.#activeId = typeof parsed.activeId === "string" ? parsed.activeId : this.#items[0]?.id;
        if (legacy) this.#write();
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
    return {
      ...item,
      project: legacyProject,
      cwd: legacyProject ?? this.#scratchRoot,
    };
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

  #flush(): void {
    const payload: CatalogFile = {
      version: 2,
      activeId: this.#activeId,
      projects: this.#projects,
      conversations: this.#items,
    };
    writeFileSync(this.#file, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

function projectsFromConversations(conversations: Conversation[]): Project[] {
  const map = new Map<string, Project>();
  for (const item of conversations) {
    const project = item.project;
    if (!project) continue;
    const existing = map.get(project);
    if (!existing || item.updatedAt > existing.updatedAt) {
      map.set(project, {
        cwd: project,
        name: existing?.name || basename(project) || project,
        updatedAt: item.updatedAt,
      });
    }
  }
  return [...map.values()];
}

function normalizeProject(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
