import type { Db } from "../engine/db.ts";
import type { BotAttention, BotConversationMeta, BotDelivery, BotInput, BotResult } from "../../shared/bot.ts";

type Row = { data: string };
const one = <T>(row?: Row): T | undefined => row ? JSON.parse(row.data) as T : undefined;
const many = <T>(rows: Row[]): T[] => rows.map((row) => JSON.parse(row.data) as T);

/** Durable conversation facts. Transcript content remains owned by the engine. */
export class BotStore {
  constructor(private readonly db: Db) {}
  transaction<T>(fn: () => T): T { return this.db.transaction(fn); }
  get revision(): number { return Number(this.meta("revision") ?? 0); }
  bumpRevision(): number { const next = this.revision + 1; this.setMeta("revision", String(next)); return next; }
  meta(key: string): string | undefined { return this.db.get<{ value: string }>("SELECT value FROM bot_meta WHERE key=?", key)?.value; }
  setMeta(key: string, value: string): void { this.db.run("INSERT INTO bot_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value); }
  get routerConversationId(): string | undefined { return this.meta("routerConversationId"); }
  setRouterConversationId(id: string): void { this.setMeta("routerConversationId", id); }

  conversation(id: string): BotConversationMeta | undefined { return one<BotConversationMeta>(this.db.get<Row>("SELECT data FROM bot_conversations WHERE conversation_id=?", id)); }
  conversationByKey(key: string): BotConversationMeta | undefined { return one<BotConversationMeta>(this.db.get<Row>("SELECT data FROM bot_conversations WHERE creation_key=?", key)); }
  conversations(): BotConversationMeta[] { return many(this.db.all<Row>("SELECT data FROM bot_conversations ORDER BY created_at,conversation_id")); }
  putConversation(value: BotConversationMeta): void {
    this.db.run("INSERT INTO bot_conversations(conversation_id,role,owner,creation_key,epoch,paused,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET epoch=excluded.epoch,paused=excluded.paused,updated_at=excluded.updated_at,data=excluded.data", value.conversationId, value.role, value.owner, value.creationKey, value.epoch, value.paused ? 1 : 0, value.createdAt, value.updatedAt, JSON.stringify(value));
  }
  input(id: string): BotInput | undefined { return one<BotInput>(this.db.get<Row>("SELECT data FROM bot_v2_inputs WHERE id=?", id)); }
  inputs(conversationId?: string): BotInput[] { return many(this.db.all<Row>(conversationId ? "SELECT data FROM bot_v2_inputs WHERE conversation_id=? ORDER BY created_at,id" : "SELECT data FROM bot_v2_inputs ORDER BY created_at,id", ...(conversationId ? [conversationId] : []))); }
  putInput(value: BotInput): void { this.db.run("INSERT INTO bot_v2_inputs(id,conversation_id,epoch,source,text,status,created_at,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,status=excluded.status,data=excluded.data", value.id, value.conversationId, value.epoch, value.source, value.text, value.status, value.createdAt, JSON.stringify(value)); }
  attention(id: string): BotAttention | undefined { return one<BotAttention>(this.db.get<Row>("SELECT data FROM bot_attention WHERE id=?", id)); }
  attentions(conversationId?: string): BotAttention[] { return many(this.db.all<Row>(conversationId ? "SELECT data FROM bot_attention WHERE conversation_id=? ORDER BY created_at,id" : "SELECT data FROM bot_attention ORDER BY created_at,id", ...(conversationId ? [conversationId] : []))); }
  putAttention(value: BotAttention): void { this.db.run("INSERT INTO bot_attention(id,conversation_id,input_id,epoch,status,created_at,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", value.id, value.conversationId, value.inputId ?? null, value.epoch, value.status, value.createdAt, JSON.stringify(value)); }
  result(id: string): BotResult | undefined { return one<BotResult>(this.db.get<Row>("SELECT data FROM bot_results WHERE id=?", id)); }
  results(conversationId?: string): BotResult[] { return many(this.db.all<Row>(conversationId ? "SELECT data FROM bot_results WHERE conversation_id=? ORDER BY created_at,id" : "SELECT data FROM bot_results ORDER BY created_at,id", ...(conversationId ? [conversationId] : []))); }
  putResult(value: BotResult): void { this.db.run("INSERT INTO bot_results(id,conversation_id,input_id,epoch,status,created_at,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", value.id, value.conversationId, value.inputId ?? null, value.epoch, value.status, value.createdAt, JSON.stringify(value)); }
  delivery(id: string): BotDelivery | undefined { return one<BotDelivery>(this.db.get<Row>("SELECT data FROM bot_outbox WHERE id=?", id)); }
  deliveries(status?: BotDelivery["status"]): BotDelivery[] { return many(this.db.all<Row>(status ? "SELECT data FROM bot_outbox WHERE status=? ORDER BY created_at,id" : "SELECT data FROM bot_outbox ORDER BY created_at,id", ...(status ? [status] : []))); }
  putDelivery(value: BotDelivery): boolean { return this.db.run("INSERT INTO bot_outbox(id,conversation_id,target_conversation_id,status,created_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING", value.id, value.conversationId, value.targetConversationId, value.status, value.createdAt, JSON.stringify(value)).changes > 0; }

  /** Temporary schema-11 readers for the migration adapter; never used by the new scheduler. */
  tasks(): import("../../shared/bot.ts").LegacyBotTask[] { return []; }
  questions(): import("../../shared/bot.ts").LegacyBotQuestion[] { return []; }

  recover(): void {
    this.transaction(() => {
      let changed = false;
      for (const input of this.inputs()) if (input.status === "running" || input.status === "accepted") { this.putInput({ ...input, status: "uncertain", error: "应用在执行期间退出，请核对现场后继续" }); changed = true; }
      for (const meta of this.conversations()) {
        if (!this.inputs(meta.conversationId).some((input) => input.status === "uncertain")) continue;
        this.putConversation({ ...meta, paused: true, updatedAt: Date.now() });
        changed = true;
      }
      if (changed) this.bumpRevision();
    });
  }
}
