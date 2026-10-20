import assert from "node:assert/strict";
import test from "node:test";
import { skillDraftOf, skillDraftText } from "../src/renderer/src/lib/skill-draft.ts";
import { applyFileMention, fileMentionAtCaret } from "../src/renderer/src/lib/file-mention.ts";

const commands = [{ name: "skill:office", source: "skill" as const }];

test("a partial skill name stays editable in the slash palette", () => {
  for (const value of ["/", "/skill:", "/skill:off", "/compact", "ordinary text"]) {
    assert.deepEqual(skillDraftOf(value, commands), { text: value });
  }
  // A complete short name can also be the prefix of a longer one. Do not turn it
  // into a chip in the middle of typing `/skill:office-writer`.
  assert.deepEqual(skillDraftOf("/skill:office", commands, true), { text: "/skill:office" });
  assert.equal(skillDraftOf("/skill:office ", commands, true).skill?.name, "office");
});

test("selection and history recall both show a skill-only draft as a badge", () => {
  for (const value of ["/skill:office", "/skill:office "]) {
    assert.deepEqual(skillDraftOf(value, commands), { skill: { name: "office" }, text: "" });
  }
  // A confirmed draft survives a project change even if the list no longer has it.
  assert.equal(skillDraftOf("/skill:office ", []).skill?.name, "office");
});

test("editing the words preserves whitespace and the skill in the stored draft", () => {
  const value = "/skill:office   第一行\n第二行  ";
  const draft = skillDraftOf(value, commands);
  assert.equal(draft.text, "  第一行\n第二行  ");
  assert.equal(skillDraftText(draft.skill, draft.text), value);
  assert.equal(skillDraftText(draft.skill, ""), "/skill:office ");
  assert.equal(skillDraftText(undefined, draft.text), draft.text);
});

test("file mentions use the visible caret and retain the selected skill", () => {
  const draft = skillDraftOf("/skill:office 请读 @notes 再总结", commands);
  const caret = draft.text.indexOf(" 再总结");
  const mention = fileMentionAtCaret(draft.text, caret)!;
  assert.equal(mention.query, "notes");
  const selected = applyFileMention(draft.text, mention);
  assert.equal(selected.value, "请读 再总结");
  assert.equal(selected.caret, 3);
  assert.equal(skillDraftText(draft.skill, selected.value), "/skill:office 请读 再总结");
});
