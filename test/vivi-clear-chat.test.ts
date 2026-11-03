import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { viviCommand, viviCommands } from "../src/shared/vivi-commands.ts";
import { viviFeedWithOptimistic } from "../src/renderer/src/lib/vivi-chat.ts";
import type { BotChatMessage } from "../src/shared/bot.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Vivi 菜单只列 /clear，命令在本地识别；普通文本与绝对路径仍可发送", () => {
  assert.deepEqual(viviCommands("清空消息"), [{ name: "clear", description: "清空消息", source: "vivi" }]);
  assert.equal(viviCommand(" /clear\n"), "clear");
  for (const value of ["/goal", "/handoff 做事", "/compact", "/skill:office", "/clear 多余参数", "/"]) assert.equal(viviCommand(value), "unsupported");
  for (const value of ["正常要求", "解释 /goal", "/Users/me/report.md", "/tmp/output"]) assert.equal(viviCommand(value), undefined);
});

test("跨端清空后，旧乐观用户行不复活；新一代输入照常显示且与服务器去重", () => {
  const old: BotChatMessage = { id: "old", conversationId: "router", role: "user", text: "旧输入", createdAt: 1 };
  assert.deepEqual(viviFeedWithOptimistic(null, old), [old]);
  const cleared = { messages: [], chatGeneration: 1 };
  assert.deepEqual(viviFeedWithOptimistic(cleared, old), []);
  const next = { ...old, id: "new", text: "新输入", historyGeneration: 1 };
  assert.deepEqual(viviFeedWithOptimistic(cleared, next), [next]);
  assert.deepEqual(viviFeedWithOptimistic({ ...cleared, messages: [next] }, next), [next]);
  assert.deepEqual(viviFeedWithOptimistic({ messages: [], chatGeneration: 2 }, next), []);
});

test("Vivi 主聊天不读取全局命令，/clear 在模型/乐观消息/附件处理之前分流；普通 composer 的命令处理保留", () => {
  const page = source("src/renderer/src/components/bot/vivi-page.tsx");
  const composer = source("src/renderer/src/components/chat/composer.tsx");
  assert.match(page, /viviCommands\(t\("viviBot.clearDescription"\)\)/);
  assert.doesNotMatch(page, /state\.commands|engine\.prompt/);
  const local = page.indexOf('command === "clear"');
  assert.ok(local > 0 && local < page.indexOf("if (!hasMainModel) return"));
  assert.ok(local < page.indexOf("attachmentsToImages(attachments)"));
  assert.ok(local < page.indexOf("optimistic: {"));
  assert.match(page, /window\.fastvibe\.bot\.clearChat\(\)/);
  assert.match(composer, /INSTANT_COMMANDS\.has\(command\.name\)/);
  assert.match(composer, /void engine\.prompt\(`/);
  assert.match(source("src/renderer/src/App.tsx"), /commands=\{paletteCommands\}/);
});

test("clear API 走共享调用表和远程策略，无独立 Electron handler；快照拒绝迟到的旧 revision", () => {
  assert.match(source("src/shared/api.ts"), /clearChat:.*t\.invoke\(Ipc\.botClearChat\)/);
  assert.match(source("src/main/ipc/bot-handlers.ts"), /handle\(Ipc\.botClearChat, \(\) => engine\.bot\.clearChat\(\)\)/);
  assert.match(source("src/shared/remote-policy.ts"), /Ipc\.botClearChat,/);
  const snapshots = source("src/renderer/src/components/bot/use-bot-snapshot.ts");
  assert.match(snapshots, /snapshot\.revision < current\.revision/);
  assert.match(snapshots, /window\.fastvibe\.bot\.onChanged/);
});
