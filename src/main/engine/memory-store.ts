import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MemoryEdge, MemoryEdgeOrigin, MemoryGraphEdge, MemoryGraphNode, MemoryItem, MemoryRelationView, MemoryTypeScores } from "@shared/memory";

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
        (id, conversation_id, project, role, kind, content, created_at, importance, confidence, source_entry_id, metadata, type_scores, entities, embedding, embedding_dim, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project=excluded.project, kind=excluded.kind, content=excluded.content,
        importance=excluded.importance, confidence=excluded.confidence,
        metadata=excluded.metadata, type_scores=excluded.type_scores, entities=excluded.entities,
        embedding=excluded.embedding, embedding_dim=excluded.embedding_dim, keywords=excluded.keywords
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
    const where = ["memory_fts MATCH ?"];
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
      const likeWhere = [`(${rawTerms.map(() => "m.content LIKE ?").join(" OR ")})`];
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
    const where: string[] = ["embedding IS NOT NULL"];
    const args: unknown[] = [];
    if (filters.conversationId) { where.push("conversation_id = ?"); args.push(filters.conversationId); }
    if (filters.project) { where.push("project = ?"); args.push(filters.project); }
    args.push(limit);
    const rows = this.#db.prepare(`SELECT * FROM memory_items WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...(args as any[])) as unknown as StoredRow[];
    return rows.map((row) => toItem(row, true));
  }

  recent(limit = 256, filters: { conversationId?: string; project?: string } = {}): MemoryCandidate[] {
    const where: string[] = [];
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
    const where: string[] = [`(${entities.map(() => "entities LIKE ?").join(" OR ")})`];
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
      WHERE 1=1 ${viewFilter}
      LIMIT ?
    `).all(...ids, ...ids, ...(views && views.length > 0 ? views : []), limit) as unknown as StoredRow[];
    return rows.map((row) => toItem(row, true));
  }

  /**
   * Every edge touching `id` with the memory at its far end, in the reference's
   * `get_neighbors` order: outgoing edges, then incoming, each in insertion order.
   */
  neighboursOf(id: string, filters: { conversationId?: string; project?: string } = {}): MemoryNeighbour[] {
    const scope: string[] = [];
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

  /** Whether any memory's metadata holds `key: value` (a string), e.g. a consolidation key. */
  hasMetadata(key: string, value: string): boolean {
    const needle = `%${JSON.stringify(key).slice(0, -1)}":${JSON.stringify(value)}%`;
    return Boolean(this.#db.prepare("SELECT 1 FROM memory_items WHERE metadata LIKE ? LIMIT 1").get(needle));
  }

  /**
   * The newest memories of a scope as graph nodes — no embeddings, no full content —
   * with the edges among them, the projects that hold memories and the scope's total.
   */
  graph(limit: number, project?: string): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; projects: string[]; total: number } {
    const where = project ? "WHERE project = ?" : "";
    const args = project ? [project] : [];
    type NodeRow = { id: string; role: MemoryItem["role"]; kind: MemoryItem["kind"]; created_at: number; preview: string; project: string | null; conversation_id: string | null; fallback: number };
    const rows = this.#db.prepare(`
      SELECT id, role, kind, created_at, substr(content, 1, ${GRAPH_PREVIEW_CHARS}) AS preview, project, conversation_id,
        coalesce(metadata LIKE '%"controller":"magma_fallback"%', 0) AS fallback
      FROM memory_items ${where} ORDER BY created_at DESC LIMIT ?
    `).all(...(args as any[]), limit) as unknown as NodeRow[];
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
