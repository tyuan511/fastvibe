import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OutputRepetitionWatch,
  findOutputRepetition,
  OUTPUT_REPETITION_MIN_REPEATS,
} from "../src/main/pi/output-repetition.ts";

/**
 * The guard exists because of two real runaway replies: a 406-character block of
 * Chinese planning prose repeated 921 times (376 KB, 27 minutes of streaming, ended by
 * hand) and a 24-character `Emit. / OK. / Let me go.` cycle repeated 1946 times. Both
 * are pinned here, and so is the boundary the detector must not cross: repeated phrases
 * are ordinary writing, and only a strictly periodic tail is a loop.
 */

/** The 406-character block the first runaway reply repeated. Inlined byte for byte. */
const PLANNING_BLOCK =
  "新版列表页状态 4 的布局将调整为「更改套餐」与「续费」并列，状态 3 则在「前往备份」和「前往续费」之间插入「更改套餐」。\n\n无权限时保持「团队已清空」文案不变。\n\n老版 `team.js` 的 `getScalePkgs` 将重写，确保无基础包时也能正确生成套餐组。\n\n已确认 `getScalePkgs` 的排序逻辑：基础包价格取最低价，容量按钮按 `noBasePkg` 标记直接展示完整月价。\n\n创建页和变更页的容量按钮模板将按 `noBasePkg` 标记调整价格计算，避免减法导致负值。\n\n过期团队详情页将增加「更改套餐」按钮，权限沿用 `GroupItemModification`。\n\n新版 `TeamRenewDialog` 的错误提示下方将增加「前往更改套餐」按钮，点击后跳转到变更页。\n\n`Billing` 续费弹窗的错误提示下方同样增加「前往更改套餐」按钮，点击后直接展开变更弹窗。\n\n";

/** The 24-character cycle the other runaway reply fell into. */
const SHORT_CYCLE = "Emit.\n\nOK.\n\nLet me go.\n\n";

const repeat = (text: string, times: number): string => text.repeat(times);

/** Enough unique prose that no window of it is periodic. */
const prose = (lines: number): string =>
  Array.from({ length: lines }, (_, index) => `第 ${index} 段：这一段只出现一次，编号 ${index * 7 + 3}。`).join("\n\n");

test("a repeated planning block is found, with the block length", () => {
  assert.equal(PLANNING_BLOCK.length, 406);
  const verdict = findOutputRepetition(repeat(PLANNING_BLOCK, 40));
  assert.deepEqual(verdict, { period: 406, repeats: 40 });
});

test("a short cycle is found the same way", () => {
  const verdict = findOutputRepetition(repeat(SHORT_CYCLE, 400));
  assert.equal(verdict?.period, 24);
  assert.equal(verdict?.repeats, Math.floor((SHORT_CYCLE.length * 400) / 24));
});

test("the partial copy at the end is not evidence", () => {
  // Seven whole blocks plus most of an eighth: the repetition is real, but the whole
  // copies alone are still one short of the threshold.
  assert.equal(findOutputRepetition(repeat(PLANNING_BLOCK, 7) + PLANNING_BLOCK.slice(0, 300)), undefined);
  // A partial copy *after* the whole ones is tolerated — the verdict counts whole
  // repeats, so a tail cut mid-block is judged on the copies that are complete.
  assert.deepEqual(
    findOutputRepetition(repeat(PLANNING_BLOCK, 8) + PLANNING_BLOCK.slice(0, 300)),
    { period: 406, repeats: 8 },
  );
});

test("one repeat below the threshold is still an ordinary answer", () => {
  const short = repeat(PLANNING_BLOCK, OUTPUT_REPETITION_MIN_REPEATS - 1);
  assert.equal(findOutputRepetition(short), undefined);
  assert.notEqual(findOutputRepetition(repeat(PLANNING_BLOCK, OUTPUT_REPETITION_MIN_REPEATS)), undefined);
});

test("prose that repeats a paragraph or a phrase is not a loop", () => {
  const paragraph = "这一轮改动到此结束，稍后我再检查一遍构建结果。";
  const body = `${prose(30)}\n\n${paragraph}\n\n${prose(30)}\n\n${paragraph}\n`;
  assert.equal(findOutputRepetition(body), undefined);
});

test("varying rows, log lines and long text are not a loop", () => {
  const table = Array.from({ length: 300 }, (_, i) => `| 实例 ${i} | 运行中 | ${i * 3}% |`).join("\n");
  const logs = Array.from({ length: 400 }, (_, i) => `2026-10-13 09:${String(i % 60).padStart(2, "0")}:00 INFO 处理第 ${i} 条`).join("\n");
  assert.equal(findOutputRepetition(table), undefined);
  assert.equal(findOutputRepetition(logs), undefined);
  assert.equal(findOutputRepetition(prose(400)), undefined);
});

test("a short tail is never judged", () => {
  assert.equal(findOutputRepetition(repeat(SHORT_CYCLE, 20)), undefined);
  assert.equal(findOutputRepetition(""), undefined);
});

test("the watch reports a loop once, then stays quiet", () => {
  const watch = new OutputRepetitionWatch();
  const stream = repeat(SHORT_CYCLE, 400);
  let first: number | undefined;
  let verdicts = 0;
  for (let at = 0; at < stream.length; at += 37) {
    const verdict = watch.push(stream.slice(at, at + 37));
    if (verdict) {
      verdicts += 1;
      first ??= at;
    }
  }
  assert.equal(verdicts, 1);
  // Reported while the reply was still being written, not at the end of it.
  assert.ok(first !== undefined && first < stream.length);
});

test("reset forgets the stream, so the next message starts clean", () => {
  const watch = new OutputRepetitionWatch();
  assert.notEqual(watch.push(repeat(SHORT_CYCLE, 400)), undefined);
  watch.reset();
  assert.equal(watch.push(repeat(SHORT_CYCLE, 4)), undefined);
  assert.equal(watch.push(prose(40)), undefined);
});
