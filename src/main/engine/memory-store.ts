import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MemoryEdge, MemoryEdgeOrigin, MemoryGraphEdge, MemoryGraphNode, MemoryItem, MemoryRelationView, MemoryTypeScores, MemoryConfig, MemoryArchiveReason, MemoryMaintenanceState } from "@shared/memory";

import { MEMORY_DAY_MS, MEMORY_MAINTENANCE_BATCH, retainedMemory, sameMemoryScope } from "./memory-retention.ts";
import type { ConsolidationDecision } from "./memory-jev.ts";

/** Characters of content a graph node carries; the detail call serves the rest. */
const GRAPH_PREVIEW_CHARS = 160;

/** Edges table; `origin` is in the key so links from different stages can coexist. */
const EDGES_TABLE = (name: string): string => `
  CREATE TABLE IF NOT EXISTS ${name} (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    view TEXT NOT NULL DEFAULT 'semantic',
    relation TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'jev',
    weight REAL NOT NULL DEFAULT 0.5,
    confidence REAL NOT NULL DEFAULT 0.5,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(source_id, target_id, view, relation, origin),
    FOREIGN KEY(source_id) REFERENCES memory_items(id) ON DELETE CASCADE,
    FOREIGN KEY(target_id) REFERENCES memory_items(id) ON DELETE CASCADE
  );`;

type StoredRow = {
  id: string;
  conversation_id: string | null;
  project: string | null;
  role: MemoryItem["role"];
  kind: MemoryItem["kind"];
  content: string;
  created_at: number;
  importance: number;
  confidence: number;
  source_entry_id: string | null;
  metadata: string | null;
  type_scores: string | null;
  entities: string | null;
  keywords?: string | null;
  embedding: Buffer | Uint8Array | null;
  embedding_dim: number | null;
  pinned: number;
  last_accessed_at: number | null;
  archived_at: number | null;
  archive_reason: MemoryArchiveReason | null;
  replacement_id: string | null;
  edge_weight?: number;
  edge_view?: MemoryRelationView;
};

export type MemoryCandidate = MemoryItem & {
  embedding?: number[];
  /** Keywords extracted at write time (Jev-Mem candidate discovery). */
  keywords?: string[];
  edgeWeight?: number;
  edgeView?: MemoryRelationView;
};

/** One inspected edge and the memory at its far end. */
export type MemoryNeighbour = {
  item: MemoryCandidate;
  edge: MemoryEdge;
};

/** SQLite-backed canonical memory store. Embeddings stay local and are never sent to Jev. */
export class MemoryStore {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        project TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.5,
        source_entry_id TEXT,
        metadata TEXT,
        type_scores TEXT,
        entities TEXT,
        embedding BLOB,
        embedding_dim INTEGER
      );
      CREATE INDEX IF NOT EXISTS memory_items_conversation ON memory_items(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS memory_items_project ON memory_items(project, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS memory_items_source ON memory_items(conversation_id, role, source_entry_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content='memory_items', content_rowid='rowid', tokenize='unicode61');
      ${EDGES_TABLE("memory_edges")}
    `);
    this.#migrateEdgeOrigin();
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS memory_edges_source ON memory_edges(source_id);
      CREATE INDEX IF NOT EXISTS memory_edges_target ON memory_edges(target_id);
      CREATE INDEX IF NOT EXISTS memory_edges_view ON memory_edges(view);
    `);
    this.#db.exec("CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    const columns = this.#db.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "keywords")) this.#db.exec("ALTER TABLE memory_items ADD COLUMN keywords TEXT;");
    this.#transaction(() => {
      for (const [name, type] of Object.entries({ pinned: "INTEGER NOT NULL DEFAULT 0", retained: "INTEGER NOT NULL DEFAULT 0", last_accessed_at: "INTEGER", archived_at: "INTEGER", archive_reason: "TEXT", replacement_id: "TEXT" })) {
        if (!columns.some((column) => column.name === name)) this.#db.exec(`ALTER TABLE memory_items ADD COLUMN ${name} ${type}`);
      }
      if (!columns.some((column) => column.name === "retained")) {
        const update = this.#db.prepare("UPDATE memory_items SET retained = ? WHERE id = ?");
        // No vectors: old indexes need the same protection as newly captured memories.
        for (const row of this.#db.prepare("SELECT id, role, kind, content, type_scores, pinned FROM memory_items").all() as unknown as StoredRow[]) {
          update.run(Number(retainedMemory(toItem(row, false))), row.id);
        }
      }
      this.#db.exec("CREATE INDEX IF NOT EXISTS memory_items_lifecycle ON memory_items(archived_at, retained, created_at)");
    });
  }

  /**
   * Edges once had one row per (pair, view, relation), so a consolidation RELATED_TO
   * could not sit beside the write-time one the reference keeps as a separate link.
   * `origin` is now part of the key; an older table is rebuilt in insertion order.
   */
  #migrateEdgeOrigin(): void {
    const columns = this.#db.prepare("PRAGMA table_info(memory_edges)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "origin")) return;
    this.#db.exec(`
      BEGIN;
      ${EDGES_TABLE("memory_edges_next")}
      INSERT INTO memory_edges_next(source_id, target_id, view, relation, origin, weight, confidence, created_at)
        SELECT source_id, target_id, view, relation,
          CASE WHEN view = 'temporal' AND relation IN ('before', 'after', 'temporally_close') THEN 'sequence' ELSE 'jev' END,
          weight, confidence, created_at
        FROM memory_edges ORDER BY rowid;
      DROP TABLE memory_edges;
      ALTER TABLE memory_edges_next RENAME TO memory_edges;
      COMMIT;
    `);
  }

  /** Small durable counters (e.g. Jev writes since install), kept beside the data they count. */
  meta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO memory_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  close(): void {
    this.#db.close();
  }

  upsert(item: Omit<MemoryItem, "score">, embedding?: number[], keywords?: string[]): void {
    const previous = this.#db.prepare("SELECT rowid, content FROM memory_items WHERE id = ?").get(item.id) as { rowid?: number; content?: string } | undefined;
    if (previous?.rowid && typeof previous.content === "string") {
      this.#db.prepare("INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', ?, ?)").run(previous.rowid, previous.content);
    }
    const encoded = embedding ? Buffer.from(new Float32Array(embedding).buffer) : null;
    this.#db.prepare(`
      INSERT INTO memory_items
        (id, conversation_id, project, role, kind, content, created_at, importance, confidence, source_entry_id, metadata, type_scores, entities, embedding, embedding_dim, keywords, retained, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project=excluded.project, kind=excluded.kind, content=excluded.content,
        importance=excluded.importance, confidence=excluded.confidence,
        metadata=excluded.metadata, type_scores=excluded.type_scores, entities=excluded.entities,
        embedding=excluded.embedding, embedding_dim=excluded.embedding_dim, keywords=excluded.keywords,
        retained=CASE WHEN memory_items.pinned = 1 THEN 1 ELSE excluded.retained END
    `).run(
      item.id,
      item.conversationId ?? null,
      item.project ?? null,
      item.role,
      item.kind,
      item.content,
      item.createdAt,
      item.importance,
      item.confidence,
      item.sourceEntryId ?? null,
      item.metadata ? JSON.stringify(item.metadata) : null,
      item.typeScores ? JSON.stringify(item.typeScores) : null,
      item.entities ? JSON.stringify(item.entities) : null,
      encoded,
      embedding?.length ?? null,
      keywords ? JSON.stringify(keywords) : null,
      Number(retainedMemory(item)),
      Number(Boolean(item.pinned)),
    );

    const row = this.#db.prepare("SELECT rowid FROM memory_items WHERE id = ?").get(item.id) as { rowid?: number } | undefined;
    if (!row?.rowid) return;
    // `memory_fts` is an external-content table: its row is maintained with the
    // FTS5 insert/delete commands above, not with a normal SQL DELETE.
    this.#db.prepare("INSERT INTO memory_fts(rowid, content) VALUES (?, ?)").run(row.rowid, item.content);
  }

  /** Insert or refresh an edge; with `ifAbsent`, an existing edge is left as it was. */
  addEdge(edge: MemoryEdge, options: { ifAbsent?: boolean } = {}): void {
    const args = [edge.sourceId, edge.targetId, edge.view, edge.relation, edge.origin ?? "jev", edge.weight, edge.confidence ?? edge.weight, Date.now()] as const;
    if (options.ifAbsent) {
      this.#db.prepare(`
        INSERT OR IGNORE INTO memory_edges(source_id, target_id, view, relation, origin, weight, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...args);
      return;
    }
    this.#db.prepare(`
      INSERT INTO memory_edges(source_id, target_id, view, relation, origin, weight, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, target_id, view, relation, origin) DO UPDATE SET
        weight=excluded.weight, confidence=excluded.confidence
    `).run(...args);
  }

  item(id: string): MemoryCandidate | undefined {
    const row = this.#db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as StoredRow | undefined;
    return row ? toItem(row, true) : undefined;
  }

  hasItems(filters: { conversationId?: string; project?: string } = {}): boolean {
    const where: string[] = ["archived_at IS NULL"];
    const args: string[] = [];
    if (filters.conversationId) { where.push("conversation_id = ?"); args.push(filters.conversationId); }
    if (filters.project) { where.push("project = ?"); args.push(filters.project); }
    return Boolean(this.#db.prepare(`SELECT 1 FROM memory_items${where.length ? ` WHERE ${where.join(" AND ")}` : ""} LIMIT 1`).get(...args));
  }

  /** Lexical anchors. FTS query is deliberately tokenised before it reaches SQLite. */
  keyword(query: string, limit: number, filters: { conversationId?: string; project?: string } = {}): MemoryCandidate[] {
    const rawTerms = query
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 1)
      .slice(0, 12);
    const terms = rawTerms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
    if (!terms) return [];
    const where = ["memory_fts MATCH ?", "m.archived_at IS NULL"];
    const args: unknown[] = [terms];
    if (filters.conversationId) { where.push("m.conversation_id = ?"); args.push(filters.conversationId); }
    if (filters.project) { where.push("m.project = ?"); args.push(filters.project); }
    args.push(limit);
    const rows = this.#db.prepare(`
      SELECT m.* FROM memory_fts f JOIN memory_items m ON m.rowid = f.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY bm25(memory_fts), m.created_at DESC LIMIT ?
    `).all(...(args as any[])) as unknown as StoredRow[];
    const candidates = rows.map((row) => toItem(row, true));
    // unicode61 treats many CJK runs as one token. A LIKE fallback keeps Default
    // memory useful for a short Chinese query without requiring an embedding model.
    if (candidates.length < limit && rawTerms.some((term) => /[^\x00-\x7f]/u.test(term))) {
      const likeWhere = ["m.archived_at IS NULL", `(${rawTerms.map(() => "m.content LIKE ?").join(" OR ")})`];
      const likeArgs: unknown[] = rawTerms.map((term) => `%${term}%`);
      if (filters.conversationId) { likeWhere.push("m.conversation_id = ?"); likeArgs.push(filters.conversationId); }
      if (filters.project) { likeWhere.push("m.project = ?"); likeArgs.push(filters.project); }
      likeArgs.push(limit);
      const fallback = this.#db.prepare(`
        SELECT m.* FROM memory_items m
        WHERE ${likeWhere.join(" AND ")}
        ORDER BY m.created_at DESC LIMIT ?
      `).all(...(likeArgs as any[])) as unknown as StoredRow[];
      const seen = new Set(candidates.map((item) => item.id));
      for (const row of fallback) {
        const item = toItem(row, true);
        if (!seen.has(item.id)) { seen.add(item.id); candidates.push(item); }
      }
    }
    return candidates.slice(0, limit);
  }

  /** Read bounded embedding candidates. The JS cosine pass keeps SQLite portable. */
  embeddings(limit = 2_000, filters: { conversationId?: string; project?: string } = {}): MemoryCandidate[] {
    const where: string[] = ["embedding IS NOT NULL", "archived_at IS NULL"];
    const args: unknown[] = [];
    if (filters.conversationId) { where.push("conversation_id = ?"); args.push(filters.conversationId); }
    if (filters.project) { where.push("project = ?"); args.push(filters.project); }
    args.push(limit);
    const rows = this.#db.prepare(`SELECT * FROM memory_items WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...(args as any[])) as unknown as StoredRow[];
    return rows.map((row) => toItem(row, true));
  }

  recent(limit = 256, filters: { conversationId?: string; project?: string } = {}): MemoryCandidate[] {
    const where: string[] = ["archived_at IS NULL"];
    const args: unknown[] = [];
    if (filters.conversationId) { where.push("conversation_id = ?"); args.push(filters.conversationId); }
    if (filters.project) { where.push("project = ?"); args.push(filters.project); }
    args.push(limit);
    const rows = this.#db.prepare(`
      SELECT * FROM memory_items
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC LIMIT ?
    `).all(...(args as any[])) as unknown as StoredRow[];
    return rows.map((row) => toItem(row, true));
  }

  byEntities(entities: string[], limit = 64, filters: { conversationId?: string; project?: string } = {}): MemoryCandidate[] {
    if (entities.length === 0) return [];
    const where: string[] = ["archived_at IS NULL", `(${entities.map(() => "entities LIKE ?").join(" OR ")})`];
    const args: unknown[] = entities.map((entity) => `%"${entity.replaceAll("%", "")}"%`);
    if (filters.conversationId) { where.push("conversation_id = ?"); args.push(filters.conversationId); }
    if (filters.project) { where.push("project = ?"); args.push(filters.project); }
    args.push(limit);
    const rows = this.#db.prepare(`SELECT * FROM memory_items WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...(args as any[])) as unknown as StoredRow[];
    return rows.map((row) => toItem(row, true));
  }

  neighbours(ids: string[], limit = 64, views?: MemoryRelationView[]): MemoryCandidate[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const viewFilter = views && views.length > 0 ? ` AND e.view IN (${views.map(() => "?").join(",")})` : "";
    const rows = this.#db.prepare(`
      SELECT DISTINCT m.*, e.weight AS edge_weight, e.view AS edge_view FROM memory_items m
      JOIN memory_edges e ON (e.target_id = m.id AND e.source_id IN (${placeholders}))
        OR (e.source_id = m.id AND e.target_id IN (${placeholders}))
      WHERE m.archived_at IS NULL ${viewFilter}
        AND EXISTS (SELECT 1 FROM memory_items a WHERE a.id = e.source_id AND a.archived_at IS NULL)
        AND EXISTS (SELECT 1 FROM memory_items b WHERE b.id = e.target_id AND b.archived_at IS NULL)
      LIMIT ?
    `).all(...ids, ...ids, ...(views && views.length > 0 ? views : []), limit) as unknown as StoredRow[];
    return rows.map((row) => toItem(row, true));
  }

  /**
   * Every edge touching `id` with the memory at its far end, in the reference's
   * `get_neighbors` order: outgoing edges, then incoming, each in insertion order.
   */
  neighboursOf(id: string, filters: { conversationId?: string; project?: string; includeArchived?: boolean } = {}): MemoryNeighbour[] {
    if (!filters.includeArchived && !this.isActive(id)) return [];
    const scope: string[] = filters.includeArchived ? [] : ["m.archived_at IS NULL"];
    const scopeArgs: unknown[] = [];
    if (filters.conversationId) { scope.push("m.conversation_id = ?"); scopeArgs.push(filters.conversationId); }
    if (filters.project) { scope.push("m.project = ?"); scopeArgs.push(filters.project); }
    const where = scope.length ? ` AND ${scope.join(" AND ")}` : "";
    type Row = StoredRow & { e_source: string; e_target: string; e_view: MemoryRelationView; e_relation: MemoryEdge["relation"]; e_origin: MemoryEdgeOrigin; e_weight: number; e_confidence: number };
    const read = (from: "source_id" | "target_id", to: "source_id" | "target_id"): MemoryNeighbour[] => {
      const rows = this.#db.prepare(`
        SELECT m.*, e.source_id AS e_source, e.target_id AS e_target, e.view AS e_view, e.relation AS e_relation,
          e.origin AS e_origin, e.weight AS e_weight, e.confidence AS e_confidence
        FROM memory_edges e JOIN memory_items m ON m.id = e.${to}
        WHERE e.${from} = ?${where}
        ORDER BY e.rowid
      `).all(id, ...(scopeArgs as any[])) as unknown as Row[];
      return rows.map((row) => ({
        item: toItem(row, true),
        edge: { sourceId: row.e_source, targetId: row.e_target, view: row.e_view, relation: row.e_relation, origin: row.e_origin, weight: row.e_weight, confidence: row.e_confidence },
      }));
    };
    return [...read("source_id", "target_id"), ...read("target_id", "source_id")];
  }

  /** Replace one memory's metadata (consolidation decisions are recorded here). */
  setMetadata(id: string, metadata: Record<string, unknown>): void {
    this.#db.prepare("UPDATE memory_items SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), id);
  }

  isActive(id: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM memory_items WHERE id = ? AND archived_at IS NULL").get(id));
  }

  /** Only returned evidence counts as use, never candidates merely examined by a search. */
  touch(ids: string[], now = Date.now()): void {
    if (ids.length === 0) return;
    const update = this.#db.prepare("UPDATE memory_items SET last_accessed_at = ? WHERE id = ? AND archived_at IS NULL");
    this.#transaction(() => { for (const id of ids) update.run(now, id); });
  }

  setPinned(id: string, pinned: boolean): void {
    const item = this.item(id);
    if (!item) return;
    if (pinned && item.archivedAt != null) { this.restore(id); return; }
    this.#db.prepare("UPDATE memory_items SET pinned = ?, retained = ? WHERE id = ?")
      .run(Number(pinned), Number(retainedMemory({ ...item, pinned })), id);
  }

  /** Restoring also retains the item so the next sweep cannot immediately evict it again. */
  restore(id: string, now = Date.now()): void {
    this.#db.prepare("UPDATE memory_items SET archived_at = NULL, archive_reason = NULL, replacement_id = NULL, pinned = 1, retained = 1, last_accessed_at = ? WHERE id = ?").run(now, id);
  }

  archive(id: string, reason: MemoryArchiveReason, now: number, replacementId?: string): boolean {
    const item = this.item(id);
    if (!item || item.archivedAt != null || item.pinned) return false;
    if (replacementId) {
      const replacement = this.item(replacementId);
      if (!replacement || replacement.archivedAt != null || replacement.id === id || !sameMemoryScope(item, replacement)) return false;
    }
    return Number(this.#db.prepare("UPDATE memory_items SET archived_at = ?, archive_reason = ?, replacement_id = ? WHERE id = ? AND archived_at IS NULL AND pinned = 0")
      .run(now, reason, replacementId ?? null, id).changes) > 0;
  }

  /** The model must establish replacement, not merely age or a contradiction. */
  applyConsolidation(sourceId: string, decisions: ConsolidationDecision[], now = Date.now()): void {
    const source = this.item(sourceId);
    if (!source || source.archivedAt != null) return;
    this.#transaction(() => {
      for (const decision of decisions) {
        const candidate = this.item(decision.candidateId);
        if (!candidate || candidate.archivedAt != null || candidate.createdAt >= source.createdAt
          || !sameMemoryScope(source, candidate) || decision.contradiction >= 0.15) continue;
        // An assistant's interpretation must not supersede the user's own statement.
        if (candidate.role === "user" && source.role !== "user") continue;
        if (decision.obsolete >= 0.95) this.archive(candidate.id, "superseded", now, sourceId);
        else if (decision.redundant >= 0.95 && candidate.role === source.role) this.archive(candidate.id, "duplicate", now, sourceId);
      }
    });
  }

  maintenanceState(maxActiveItems: number): MemoryMaintenanceState {
    const row = this.#db.prepare("SELECT count(*) AS total, count(archived_at) AS archived FROM memory_items").get() as { total: number; archived: number };
    let last: Partial<MemoryMaintenanceState> = {};
    try { last = JSON.parse(this.meta("maintenance") ?? "{}"); } catch { /* old/corrupt optional statistics */ }
    const active = Number(row.total) - Number(row.archived);
    return { ...last, active, archived: Number(row.archived), overBudget: Math.max(0, active - maxActiveItems) };
  }

  /** One bounded idle batch. A continuation is due until every category is drained.
   * All mutations, the FTS delete commands and the durable checkpoint commit together. */
  maintain(config: MemoryConfig, now = Date.now()): MemoryMaintenanceState {
    if (!config.autoMaintain) return this.maintenanceState(config.maxActiveItems);
    let archived = 0, deleted = 0, pending = false;
    const batch = MEMORY_MAINTENANCE_BATCH;
    this.#transaction(() => {
      const expiredArchive = this.#db.prepare("SELECT id FROM memory_items WHERE archived_at <= ? AND pinned = 0 ORDER BY archived_at LIMIT ?")
        .all(now - config.archiveRetentionDays * MEMORY_DAY_MS, batch) as { id: string }[];
      for (const { id } of expiredArchive) if (this.delete(id)) deleted++;
      pending ||= expiredArchive.length === batch;

      // Exact copies only, with the same speaker and project/chat scope. Whitespace
      // inside code is meaningful, so do not normalize it. A pinned copy wins.
      const duplicates = this.#db.prepare(`
        WITH ranked AS (
          SELECT id, pinned, first_value(id) OVER w AS keeper, row_number() OVER w AS n
          FROM memory_items WHERE archived_at IS NULL
          WINDOW w AS (PARTITION BY project, CASE WHEN project IS NULL THEN conversation_id END, role, content
            ORDER BY pinned DESC, created_at DESC, id DESC)
        ) SELECT id, keeper FROM ranked WHERE n > 1 AND pinned = 0 LIMIT ?
      `).all(batch) as { id: string; keeper: string }[];
      for (const { id, keeper } of duplicates) if (this.archive(id, "duplicate", now, keeper)) archived++;
      pending ||= duplicates.length === batch;

      const expired = this.#db.prepare(`SELECT id FROM memory_items
        WHERE archived_at IS NULL AND retained = 0 AND kind IN ('task', 'episode')
          AND max(created_at, coalesce(last_accessed_at, created_at)) <= ?
        ORDER BY created_at LIMIT ?`).all(now - config.temporaryRetentionDays * MEMORY_DAY_MS, batch) as { id: string }[];
      for (const { id } of expired) if (this.archive(id, "expired", now)) archived++;
      pending ||= expired.length === batch;

      const overflow = this.maintenanceState(config.maxActiveItems).overBudget;
      if (overflow > 0) {
        const victims = this.#db.prepare(`SELECT id FROM memory_items WHERE archived_at IS NULL AND retained = 0
          ORDER BY CASE WHEN kind IN ('task', 'episode', 'other') THEN 0 ELSE 1 END,
            importance ASC, max(created_at, coalesce(last_accessed_at, created_at)) ASC, id ASC LIMIT ?`)
          .all(Math.min(batch, overflow)) as { id: string }[];
        for (const { id } of victims) if (this.archive(id, "capacity", now)) archived++;
        pending ||= victims.length === batch && overflow > batch;
      }
      const previous = this.maintenanceState(config.maxActiveItems);
      this.setMeta("maintenance", JSON.stringify({ lastRunAt: now, pending,
        archivedLastRun: (previous.pending ? previous.archivedLastRun ?? 0 : 0) + archived,
        deletedLastRun: (previous.pending ? previous.deletedLastRun ?? 0 : 0) + deleted }));
    });
    // SQLite reuses freed pages. Avoid a blocking full VACUUM on the Electron thread.
    return this.maintenanceState(config.maxActiveItems);
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Whether any memory's metadata holds `key: value` (a string), e.g. a consolidation key. */
  hasMetadata(key: string, value: string): boolean {
    const needle = `%${JSON.stringify(key).slice(0, -1)}":${JSON.stringify(value)}%`;
    return Boolean(this.#db.prepare("SELECT 1 FROM memory_items WHERE metadata LIKE ? LIMIT 1").get(needle));
  }

  /**
   * The newest memories of a scope as graph nodes — no embeddings, no full content —
   * with the edges among them, the projects that hold memories and the scope's total.
   */
  graph(limit: number, project?: string, status: "active" | "archived" = "active", offset = 0): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; projects: string[]; total: number } {
    const where = `WHERE archived_at IS ${status === "archived" ? "NOT " : ""}NULL${project ? " AND project = ?" : ""}`;
    const args = project ? [project] : [];
    type NodeRow = { id: string; role: MemoryItem["role"]; kind: MemoryItem["kind"]; created_at: number; preview: string; project: string | null; conversation_id: string | null; fallback: number };
    const rows = this.#db.prepare(`
      SELECT id, role, kind, created_at, substr(content, 1, ${GRAPH_PREVIEW_CHARS}) AS preview, project, conversation_id,
        coalesce(metadata LIKE '%"controller":"magma_fallback"%', 0) AS fallback
      FROM memory_items ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...(args as any[]), limit, offset) as unknown as NodeRow[];
    const nodes = rows.map((row): MemoryGraphNode => ({
      id: row.id,
      role: row.role,
      kind: row.kind,
      createdAt: row.created_at,
      preview: row.preview,
      ...(row.project ? { project: row.project } : {}),
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ...(row.fallback ? { fallback: true } : {}),
    }));
    const ids = nodes.map((node) => node.id);
    const placeholders = ids.map(() => "?").join(",");
    type EdgeRow = { source_id: string; target_id: string; view: MemoryRelationView; relation: MemoryEdge["relation"]; origin: MemoryEdgeOrigin; weight: number };
    const edgeRows = ids.length === 0 ? [] : this.#db.prepare(`
      SELECT source_id, target_id, view, relation, origin, weight FROM memory_edges
      WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders}) ORDER BY rowid
    `).all(...ids, ...ids) as unknown as EdgeRow[];
    const projects = (this.#db.prepare("SELECT project FROM memory_items WHERE project IS NOT NULL GROUP BY project ORDER BY MAX(created_at) DESC").all() as Array<{ project: string }>).map((row) => row.project);
    const total = Number((this.#db.prepare(`SELECT COUNT(*) AS count FROM memory_items ${where}`).get(...(args as any[])) as { count: number }).count);
    return {
      nodes,
      edges: edgeRows.map((row) => ({ sourceId: row.source_id, targetId: row.target_id, view: row.view, relation: row.relation, origin: row.origin, weight: row.weight })),
      projects,
      total,
    };
  }

  count(): { items: number; edges: number } {
    const items = this.#db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as { count: number };
    const edges = this.#db.prepare("SELECT COUNT(*) AS count FROM memory_edges").get() as { count: number };
    return { items: Number(items.count), edges: Number(edges.count) };
  }

  delete(id: string): boolean {
    const previous = this.#db.prepare("SELECT rowid, content FROM memory_items WHERE id = ?").get(id) as { rowid?: number; content?: string } | undefined;
    if (previous?.rowid && typeof previous.content === "string") {
      this.#db.prepare("INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', ?, ?)").run(previous.rowid, previous.content);
    }
    const result = this.#db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  clear(): void {
    this.#db.exec("DELETE FROM memory_edges; DELETE FROM memory_items; DELETE FROM memory_meta; INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');");
  }
}

export function stableMemoryId(conversationId: string | undefined, role: string, sourceEntryId: string | undefined, content: string): string {
  return createHash("sha256")
    .update(`${conversationId ?? "global"}\n${role}\n${sourceEntryId ?? ""}\n${content}`)
    .digest("hex")
    .slice(0, 32);
}

function toItem(row: StoredRow, includeEmbedding: boolean): MemoryCandidate {
  const item: MemoryCandidate = {
    id: row.id,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.project ? { project: row.project } : {}),
    role: row.role,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
    importance: row.importance,
    confidence: row.confidence,
    ...(row.pinned ? { pinned: true } : {}),
    ...(row.last_accessed_at != null ? { lastAccessedAt: row.last_accessed_at } : {}),
    ...(row.archived_at != null ? { archivedAt: row.archived_at } : {}),
    ...(row.archive_reason ? { archiveReason: row.archive_reason } : {}),
    ...(row.replacement_id ? { replacementId: row.replacement_id } : {}),
    ...(row.source_entry_id ? { sourceEntryId: row.source_entry_id } : {}),
    ...(row.metadata ? { metadata: parseMetadata(row.metadata) } : {}),
    ...(row.type_scores ? { typeScores: parseTypeScores(row.type_scores) } : {}),
    ...(row.entities ? { entities: parseEntities(row.entities) } : {}),
  };
  if (row.keywords) item.keywords = parseEntities(row.keywords);
  if (typeof row.edge_weight === "number") item.edgeWeight = row.edge_weight;
  if (row.edge_view) item.edgeView = row.edge_view;
  if (includeEmbedding && row.embedding && row.embedding_dim) {
    const bytes = row.embedding instanceof Buffer ? row.embedding : Buffer.from(row.embedding);
    item.embedding = Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, row.embedding_dim));
  }
  return item;
}

function parseTypeScores(value: string): MemoryTypeScores | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<MemoryTypeScores>;
    if (["episodic", "semantic", "procedural", "preference"].every((key) => typeof parsed[key as keyof MemoryTypeScores] === "number")) {
      return parsed as MemoryTypeScores;
    }
  } catch {
    // Ignore malformed optional metadata.
  }
  return undefined;
}

function parseEntities(value: string): string[] | undefined {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
  } catch {
    return undefined;
  }
}


function parseMetadata(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
