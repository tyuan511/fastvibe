import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import {
  SKILL_BLOCK,
  isSkillCommand,
  parseSkillInvocation,
  skillCommandOf,
  skillDisplayOf,
  skillPromptText,
  stripSkillInvocation,
} from "../src/shared/skill-invocation.ts";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";
import { optimisticQueuedTurn } from "../src/renderer/src/stores/session-reducer.ts";
import { promptPreview } from "../src/main/engine/prompt-preview.ts";
import { suggestionMaterial } from "../src/main/engine/reply-suggestion.ts";

/**
 * `/skill:office 帮我写个周报` is expanded by the engine into the whole `SKILL.md` before
 * the message is persisted, so a transcript row holds the model's instruction sheet where
 * a person reads their own prompt. These pin the fold back: a badge with the skill's name,
 * and the bubble, the queued row, the sidebar preview and the generated title all saying
 * what was typed.
 */

const BODY = "References are relative to /skills/office.\n\n# Office 文档\n\n用 officecli 读写 docx。";

/** The block the engine writes, built the way the engine builds it. */
function expanded(name: string, args = "", location = "/skills/office/SKILL.md"): string {
  const block = `<skill name="${name}" location="${location}">\n${BODY}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

test("reads the expanded block: name, path and the person's own words", () => {
  const parsed = parseSkillInvocation(expanded("office", "帮我写个周报"));
  assert.ok(parsed);
  assert.equal(parsed.name, "office");
  assert.equal(parsed.location, "/skills/office/SKILL.md");
  assert.equal(parsed.args, "帮我写个周报");
  assert.equal(stripSkillInvocation(expanded("office", "帮我写个周报")), "帮我写个周报");
});

test("a skill forced with nothing typed after it still reads as an invocation", () => {
  const parsed = parseSkillInvocation(expanded("pdf"));
  assert.equal(parsed?.name, "pdf");
  assert.equal(parsed?.args, "");
  // The row is the badge alone: no empty bubble, and nothing to expand.
  const row = skillDisplayOf(expanded("pdf"));
  assert.deepEqual(row, { text: "", skill: { name: "pdf", location: "/skills/office/SKILL.md" } });
});

test("attachment metadata after the args survives the fold", () => {
  // The composer appends the file block last, so it lands inside the words-after-skill
  // group — chips are rebuilt from it by `extractPromptAttachments`, which must keep
  // reading the same text.
  const text = `${expanded("office")}\n\n<fastvibe-attachments>\n- /tmp/a.docx\n</fastvibe-attachments>`;
  const parsed = parseSkillInvocation(text);
  assert.equal(parsed?.name, "office");
  assert.match(parsed?.args ?? "", /<fastvibe-attachments>/);
});

test("reads the draft form the composer sends", () => {
  const parsed = parseSkillInvocation("/skill:skill-creator 帮我改改技能");
  assert.equal(parsed?.name, "skill-creator");
  assert.equal(parsed?.args, "帮我改改技能");
  assert.equal(parsed?.location, undefined, "a draft carries no path — only the engine's expansion records one");
  assert.equal(isSkillCommand("/skill:office"), true);
  assert.equal(isSkillCommand("  /skill:office 帮我"), true);
  assert.equal(isSkillCommand("/compact 整理一下"), false);
  assert.equal(isSkillCommand("/goal 跑完这个发布"), false);
});

test("a message that merely quotes a skill block is the person's own text", () => {
  // The block is anchored to the whole message on purpose: folding a reply that *shows*
  // this markup, or a prompt that contains it mid-sentence, would delete what was written.
  const quoted = `看看这段：<skill name="office" location="/x/SKILL.md">\n${BODY}\n</skill> 说的是什么`;
  assert.equal(parseSkillInvocation(quoted), null);
  assert.equal(skillPromptText(quoted), quoted);
  assert.equal(parseSkillInvocation("普通提示词里没有技能"), null);
});

test("folding back to the command keeps both spellings interchangeable", () => {
  const block = expanded("office", "帮我写个周报");
  assert.equal(skillPromptText(block), "/skill:office 帮我写个周报");
  assert.equal(skillPromptText("/skill:office 帮我写个周报"), "/skill:office 帮我写个周报");
  assert.equal(skillPromptText("没有技能"), "没有技能");
  assert.equal(skillPromptText(expanded("office")), "/skill:office");
});

test("an edited turn puts the command back, or the skill is gone from the retry", () => {
  assert.equal(skillCommandOf({ name: "office" }, "帮我写个周报"), "/skill:office 帮我写个周报");
  assert.equal(skillCommandOf({ name: "office" }, ""), "/skill:office");
  assert.equal(skillCommandOf(undefined, "帮我写个周报"), "帮我写个周报");
});

test("the engine's own parser agrees with this one", () => {
  for (const text of [expanded("office", "帮我写个周报"), expanded("pdf"), `  ${expanded("office", "带空格")}  `]) {
    const theirs = parseSkillBlock(text.trim());
    const ours = parseSkillInvocation(text);
    assert.ok(theirs, `the engine reads a skill block in ${JSON.stringify(text.slice(0, 24))}`);
    assert.equal(ours?.name, theirs.name);
    assert.equal(ours?.location, theirs.location);
    assert.equal(ours?.args, (theirs.userMessage ?? "").trim());
  }
  // The engine's shape and ours are one regex: a change upstream stops this test, rather
  // than quietly putting SKILL.md bodies back into every user bubble.
  assert.equal(parseSkillBlock("普通提示词"), null);
  assert.equal(parseSkillBlock(expanded("office", "帮我写个周报"))?.name, "office");
});

test("the transcript row keeps the words and carries a badge", () => {
  const messages = mapEngineMessages([
    { type: "message", message: { role: "user", content: [{ type: "text", text: expanded("office", "帮我写个周报") }], timestamp: 5 } },
    { type: "message", message: { role: "assistant", content: "好的", timestamp: 6 } },
  ]);
  assert.equal(messages.length, 2);
  const row = messages[0];
  assert.equal(row.role, "user");
  assert.equal(row.text, "帮我写个周报");
  assert.deepEqual(row.parts, [{ kind: "text", text: "帮我写个周报" }]);
  assert.deepEqual(row.skill, { name: "office", location: "/skills/office/SKILL.md" });
  assert.equal(row.createdAt, 5);
});

test("a skill with no words of its own is still a turn on screen", () => {
  const messages = mapEngineMessages([
    { type: "message", message: { role: "user", content: [{ type: "text", text: expanded("office") }], timestamp: 5 } },
  ]);
  assert.equal(messages.length, 1, "a row with no text is dropped only when it is not a skill turn");
  assert.equal(messages[0].text, "");
  assert.deepEqual(messages[0].parts, []);
  assert.equal(messages[0].skill?.name, "office");
});

test("the row drawn at 立即 is the row the transcript will read back", () => {
  const [turn] = optimisticQueuedTurn({ id: "q1", text: "/skill:office 帮我写个周报" });
  assert.equal(turn.text, "帮我写个周报");
  assert.deepEqual(turn.skill, { name: "office" });
  assert.deepEqual(turn.parts, [{ kind: "text", text: "帮我写个周报" }]);
});

test("the sidebar preview and the generated title read what was typed", () => {
  const block = expanded("office", "帮我写个季度总结");
  const { title, preview } = promptPreview({ title: "新会话" }, block);
  assert.equal(preview, "/skill:office 帮我写个季度总结");
  assert.equal(title, "/skill:office 帮我写个季度总结");
  // …and the draft form gives the very same row, whichever path wrote it.
  assert.deepEqual(promptPreview({ title: "新会话" }, "/skill:office 帮我写个季度总结"), { title, preview });
});

test("the title extension folds the block too — an extension cannot import the shared module", () => {
  const source = readFileSync("resources/extensions/session-title.ts", "utf-8");
  const written = /const SKILL_BLOCK = (\/.*\/);/.exec(source)?.[1];
  assert.ok(written, "the extension spells the block out itself");
  assert.equal(written, String(SKILL_BLOCK));
});

test("a reply suggestion is guessed from the words, not from a skill's instructions", () => {
  const material = suggestionMaterial([
    { role: "user", content: [{ type: "text", text: expanded("office", "帮我写个周报") }] },
    { role: "assistant", content: [{ type: "text", text: "好的，这就写。" }], stopReason: "stop" },
  ]);
  assert.equal(material?.user, "帮我写个周报");
});
