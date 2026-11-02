import type { EngineEvent, PermissionRequest } from "../../../shared/types.ts";
import type { ViviMood } from "../../../shared/vivi.ts";
import { parsePermission } from "../stores/session-reducer.ts";

export type ViviAgentInfo = { id: string; title: string; mood: ViviMood; tool?: string; reply?: string; replyRevision?: number };

export class ViviAgentActivity {
  #agents = new Map<string, ViviAgentInfo>();
  #pending = new Map<string, PermissionRequest>();
  #revision = 0;
  #completed = new Map<string, number>();
  #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  #expire(): void {
    for (const [id, at] of this.#completed) {
      if (this.#now() - at < 5000) continue;
      const agent = this.#agents.get(id);
      if (agent?.mood === "success") agent.mood = "idle";
      this.#completed.delete(id);
    }
  }

  get revision(): number { return this.#revision; }
  get agents(): ViviAgentInfo[] { this.#expire(); return [...this.#agents.values()]; }
  get requests(): PermissionRequest[] { return [...this.#pending.values()]; }

  setCatalog(conversations: readonly { id: string; title: string }[]): void {
    for (const conversation of conversations) {
      const existing = this.#agents.get(conversation.id);
      this.#agents.set(conversation.id, { ...existing, id: conversation.id, title: conversation.title, mood: existing?.mood ?? "idle" });
    }
  }

  restore(pending: Array<Record<string, unknown>>, running: string[], revision = this.#revision): boolean {
    if (revision !== this.#revision) return false;
    this.#pending.clear();
    for (const event of pending) {
      const request = parsePermission(event as EngineEvent);
      if (request) this.#pending.set(request.id, request);
    }
    for (const agent of this.#agents.values()) {
      if (running.includes(agent.id)) {
        if (agent.mood !== "thinking") agent.mood = "working";
      } else if (agent.mood === "working" || agent.mood === "thinking") { agent.mood = "idle"; agent.tool = undefined; }
    }
    for (const id of running) {
      const agent = this.#agent(id);
      if (agent.mood !== "thinking") agent.mood = "working";
    }
    return true;
  }

  setReply(id: string, text: string, revision: number): boolean {
    const agent = this.#agent(id);
    if ((agent.replyRevision ?? 0) !== revision) return false;
    const reply = text.slice(-4000);
    if (agent.reply === reply) return false;
    agent.reply = reply;
    return true;
  }

  remove(id: string): void {
    if (this.#pending.delete(id)) this.#revision++;
  }

  #agent(id: string): ViviAgentInfo {
    const agent = this.#agents.get(id) ?? { id, title: "", mood: "idle" as const };
    this.#agents.set(id, agent);
    return agent;
  }

  event(event: EngineEvent): boolean {
    const type = String(event.type);
    const id = typeof event.conversationId === "string" ? event.conversationId : "";
    if (type === "extension_ui_request") {
      const request = parsePermission(event);
      if (!request) return false;
      this.#pending.set(request.id, request);
    } else if (type === "extension_ui_dismiss") {
      if (typeof event.id === "string") this.#pending.delete(event.id);
    } else if (id && type === "conversation_running") {
      const agent = this.#agent(id);
      agent.mood = event.running === true ? "working" : "idle";
      if (event.running === true) { agent.reply = ""; agent.replyRevision = (agent.replyRevision ?? 0) + 1; }
      this.#completed.delete(id);
      if (event.running !== true) agent.tool = undefined;
    } else if (id && type === "conversation_activity") {
      const agent = this.#agent(id);
      agent.mood = event.status === "failed" ? "error" : "success";
      if (agent.mood === "success") this.#completed.set(id, this.#now());
      agent.tool = undefined;
    } else if (id && type === "message_update") {
      const inner = event.assistantMessageEvent;
      const content = inner && typeof inner === "object" ? inner as Record<string, unknown> : {};
      const phase = content.type;
      const agent = this.#agent(id);
      const mood = phase === "thinking_start" || phase === "thinking_delta" ? "thinking" : "working";
      if (phase === "text_start") { agent.reply = ""; agent.replyRevision = (agent.replyRevision ?? 0) + 1; }
      if (phase === "text_delta") {
        const delta = typeof content.delta === "string" ? content.delta : typeof content.text === "string" ? content.text : "";
        agent.reply = `${agent.reply ?? ""}${delta}`.slice(-4000);
        agent.replyRevision = (agent.replyRevision ?? 0) + 1;
      } else if (agent.mood === mood && phase !== "text_start") return false;
      agent.mood = mood;
    } else if (id && type === "tool_execution_start") {
      const agent = this.#agent(id);
      agent.mood = "working";
      agent.tool = typeof event.toolName === "string" ? event.toolName : undefined;
    } else if (id && type === "tool_execution_end") {
      this.#agent(id).tool = undefined;
    } else return false;
    if (type !== "message_update" && type !== "tool_execution_start" && type !== "tool_execution_end") this.#revision++;
    return true;
  }
}

const FEEDBACK = {
  zh: ["嘿，我在呢～", "眨眨眼，收到！", "给你比个 wink～", "啊？叫我啦？", "伸个懒腰，继续陪你。", "让我看看你在做什么。", "踮起脚也要看到你！", "蹦一下，精神啦！", "左右摇摇，放松一下～", "转一圈给你看！", "我换个角度看看～", "陪你慢慢来。"],
  en: ["Hey, I’m here!", "Blink blink. Got it!", "A little wink for you!", "Oh! You called?", "A little stretch. Still here!", "Let me see what you’re up to.", "Up on my toes!", "A little hop for you!", "A little wiggle to relax!", "One quick spin for you!", "Let me look from this side!", "Right here with you."],
};

export function viviClickFeedback(language: "zh" | "en", index: number): string {
  const lines = FEEDBACK[language];
  return lines[((index % lines.length) + lines.length) % lines.length];
}
