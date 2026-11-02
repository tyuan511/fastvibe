import type { ViviDragMotion } from "../../../shared/vivi.ts";

export type ViviChatterKind = "drag" | "throw" | "catch" | "land" | "bump" | "hard-bump" | "hover" | "idle";
const LINES: Record<ViviChatterKind, { zh: readonly string[]; en: readonly string[] }> = {
  drag: { zh: ["诶？要带我去哪儿呀？", "出发！换个地方陪你。", "轻点轻点，我的脚还没跟上～"], en: ["Oh! Where are we going?", "Off we go! A new spot to keep you company.", "Easy! My feet are still catching up!"] },
  throw: { zh: ["哇——起飞啦！", "等一下，我还没系安全带！", "咻！这下真的飞起来了～"], en: ["Wheee! Taking off!", "Wait, I haven’t buckled up!", "Whoosh! I’m really flying!"] },
  catch: { zh: ["接住啦！还是你手里稳当。", "呼，还好你接住我了～", "被你抓回来啦！"], en: ["Caught me! Nice and safe.", "Phew, glad you caught me!", "You’ve got me again!"] },
  land: { zh: ["落地！这里风景不错。", "站稳啦，我就在这儿陪你。", "搬家完成，继续营业～"], en: ["Landed! Nice view from here.", "Steady now. I’ll keep you company here.", "All moved in. Back to keeping you company!"] },
  bump: { zh: ["哎哟，碰到边边了。", "前面没路啦，我弹回来～", "咚！这面墙有点硬。"], en: ["Oops, found the edge!", "End of the road. Bouncing back!", "Bonk! That wall is solid."] },
  "hard-bump": { zh: ["哇啊！撞扁了一点点……", "咚！让我缓一缓，星星都晃了。", "这一下有点猛，我没事～"], en: ["Whoa! A little squished…", "Bonk! Give me a moment. Even my sparkle wobbled.", "That was a big one. I’m okay!"] },
  hover: { zh: ["在看我吗？我也在看你～", "我在呢，要一起做点什么？", "悄悄探个头，陪你一下。"], en: ["Looking at me? I’m looking at you too!", "I’m here. Shall we do something together?", "Just peeking in to keep you company."] },
  idle: { zh: ["伸个懒腰，也记得让眼睛休息一下～", "我在这儿，有事叫我就好。", "今天也陪你慢慢把事情做好。", "刚刚练了个转圈，差点没站稳。"], en: ["A little stretch. Give your eyes a break too!", "Right here if you need me.", "We’ll take things one step at a time.", "Just practiced a spin. Almost lost my balance!"] },
};
const PRIORITY: Record<ViviChatterKind, number> = { drag: 1, throw: 2, catch: 3, land: 1, bump: 4, "hard-bump": 5, hover: 0, idle: 0 };

export class ViviChatter {
  #moving = false;
  #flying = false;
  #lastFlyingAt = -Infinity;
  #pending: ViviChatterKind | undefined;
  #lastSpoke = -Infinity;
  #lastInteraction: number;
  #lastKind = new Map<ViviChatterKind, number>();
  #counts = new Map<ViviChatterKind, number>();
  #idleDue: number;
  #hoverAt: number | undefined;
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#lastInteraction = now();
    this.#idleDue = now() + 60000;
  }

  interacted(): void {
    this.#lastInteraction = this.#now();
    this.#idleDue = this.#now() + 60000;
  }

  hover(inside: boolean): void {
    if (inside && this.#hoverAt === undefined) this.#hoverAt = this.#now();
    if (!inside) this.#hoverAt = undefined;
  }

  #offer(kind: ViviChatterKind): void {
    if (!this.#pending || PRIORITY[kind] > PRIORITY[this.#pending]) this.#pending = kind;
  }

  motion(motion: ViviDragMotion): void {
    const moving = motion.dragging || motion.flying === true;
    if (motion.dragging && !this.#moving) this.#offer("drag");
    if (motion.dragging && (this.#flying || this.#now() - this.#lastFlyingAt < 150)) this.#offer("catch");
    if (motion.flying && !this.#flying) this.#offer("throw");
    if (motion.impact && motion.impact.speed > 100) {
      this.#offer(motion.impact.speed / Math.max(1, motion.size) > 7 ? "hard-bump" : "bump");
    }
    if (!moving && this.#moving) this.#offer("land");
    if (moving || this.#moving) this.interacted();
    this.#moving = moving;
    if (motion.flying) this.#lastFlyingAt = this.#now();
    this.#flying = motion.flying === true;
  }

  next(language: "zh" | "en", blocked: boolean): string | undefined {
    const now = this.#now();
    if (blocked) {
      this.#pending = undefined;
      this.#idleDue = now + 60000;
      return;
    }
    if (this.#moving || now - this.#lastInteraction < 200) return;
    if (this.#hoverAt !== undefined && now - this.#hoverAt >= 1400 && now - this.#lastInteraction > 8000) {
      this.#offer("hover");
      this.#hoverAt = undefined;
    }
    if (now >= this.#idleDue) {
      this.#offer("idle");
      this.#idleDue = now + 75000;
    }
    const kind = this.#pending;
    if (!kind) return;
    if (now - this.#lastSpoke < 3500) return;
    this.#pending = undefined;
    const cooldown = kind === "hover" || kind === "idle" ? 45000 : 5000;
    if (now - (this.#lastKind.get(kind) ?? -Infinity) < cooldown) return;
    const lines = LINES[kind][language];
    const index = this.#counts.get(kind) ?? 0;
    this.#counts.set(kind, index + 1);
    this.#lastKind.set(kind, now);
    this.#lastSpoke = now;
    return lines[index % lines.length];
  }
}
