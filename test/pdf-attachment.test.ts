import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasPdfExtension,
  isPdfAttachment,
  isPdfMimeType,
  pdfReminder,
  pdfSkillFile,
  pdfTurnPaths,
} from "../resources/extensions/pdf-attachment.ts";

/**
 * 附件里有 PDF 时，宿主把一段「先读 pdf 技能」的提醒放进系统提示。这个判断是这个
 * 功能唯一的逻辑，它的失败方式很安静：漏判 → 模型凭直觉处理 PDF，踩「值写进去了
 * 但显示不出来」「字压到框线上」这类坑；误判 → 每回合多一段没用的提示，白烧上下文。
 *
 * 所以这里测的是边界：元数据不全的附件（MIME 缺失、只有名字、只有路径）、
 * 用户手写在提示词里的路径、以及「不该触发」的那一侧——`.pdf` 出现在句子中间、
 * 后缀相似但不是 PDF 的文件。
 */

test("后缀判断大小写都认，带查询串也认", () => {
  assert.equal(hasPdfExtension("report.pdf"), true);
  assert.equal(hasPdfExtension("REPORT.PDF"), true);
  assert.equal(hasPdfExtension("/tmp/a/b/Report.Pdf"), true);
  // 从 URL 或带参数的路径粘过来会带查询串
  assert.equal(hasPdfExtension("https://x.dev/a.pdf?token=1"), true);
  assert.equal(hasPdfExtension("a.pdf#page=3"), true);
});

test("后缀判断不误伤相似的名字", () => {
  // `.pdfx`、`.pdf` 出现在中间、以及只是提到这个词，都不算
  assert.equal(hasPdfExtension("a.pdfx"), false);
  assert.equal(hasPdfExtension("pdf"), false);
  assert.equal(hasPdfExtension("pdf-notes.txt"), false);
  assert.equal(hasPdfExtension("a.pdf.txt"), false);
  assert.equal(hasPdfExtension(""), false);
});

test("MIME 判断忽略参数部分", () => {
  assert.equal(isPdfMimeType("application/pdf"), true);
  assert.equal(isPdfMimeType("APPLICATION/PDF"), true);
  assert.equal(isPdfMimeType("application/pdf; charset=binary"), true);
  assert.equal(isPdfMimeType("application/x-pdf"), true);
  assert.equal(isPdfMimeType("application/octet-stream"), false);
  assert.equal(isPdfMimeType(undefined), false);
  assert.equal(isPdfMimeType(""), false);
});

test("附件三条线索任一命中就算 PDF", () => {
  assert.equal(isPdfAttachment({ mimeType: "application/pdf" }), true);
  assert.equal(isPdfAttachment({ name: "合同.pdf" }), true);
  assert.equal(isPdfAttachment({ path: "/tmp/scan.PDF" }), true);
  // 拖进来的文件经常 MIME 缺失，只有名字是对的——这正是不能只信 MIME 的原因
  assert.equal(isPdfAttachment({ name: "report.pdf", mimeType: "application/octet-stream" }), true);
  assert.equal(isPdfAttachment({ name: "photo.png", mimeType: "image/png" }), false);
  assert.equal(isPdfAttachment({}), false);
});

test("用户手写在提示词里的 PDF 路径也会被认出来", () => {
  const paths = pdfTurnPaths("帮我看看 /tmp/合同.pdf 和 ./reports/Q3.pdf，另外 a.pdfx 不算");
  assert.deepEqual(paths, ["/tmp/合同.pdf", "./reports/Q3.pdf"]);
});

test("提示词里的路径会剥掉引号和中英文尾部标点", () => {
  assert.deepEqual(pdfTurnPaths('读一下 "notes.pdf".'), ["notes.pdf"]);
  assert.deepEqual(pdfTurnPaths("看看（附件.pdf），谢谢"), ["附件.pdf"]);
  assert.deepEqual(pdfTurnPaths("see <a.pdf>, and 'b.pdf'"), ["a.pdf", "b.pdf"]);
});

test("文件名里配对的括号保留，粘在括号前的正文切掉", () => {
  assert.deepEqual(pdfTurnPaths("看看（报告（2024）.pdf）吧"), ["报告（2024）.pdf"]);
  assert.deepEqual(pdfTurnPaths("读 /tmp/scan(1).pdf"), ["/tmp/scan(1).pdf"]);
  assert.deepEqual(pdfTurnPaths("文件：a.pdf、b.pdf。"), ["a.pdf", "b.pdf"]);
});

test("附件和提示词里的同一个文件只报一次", () => {
  const paths = pdfTurnPaths("/tmp/a.pdf", [{ name: "a.pdf", path: "/tmp/a.pdf" }]);
  assert.deepEqual(paths, ["/tmp/a.pdf"]);
});

test("没有 PDF 的一回合返回空数组，不触发提醒", () => {
  assert.deepEqual(pdfTurnPaths("普通问题"), []);
  assert.deepEqual(pdfTurnPaths("看看这张图", [{ name: "a.png", mimeType: "image/png" }]), []);
  // 句子里提到 pdf 这个词，但没有文件路径
  assert.deepEqual(pdfTurnPaths("pdf 是什么格式"), []);
});

test("提醒里点名了文件，也给出了技能文件的位置", () => {
  const reminder = pdfReminder(["/tmp/a.pdf", "/tmp/b.pdf"], "/res/skills/pdf/SKILL.md");
  assert.match(reminder, /\/tmp\/a\.pdf/);
  assert.match(reminder, /\/tmp\/b\.pdf/);
  assert.match(reminder, /\/res\/skills\/pdf\/SKILL\.md/);
});

test("技能文件位置跟着资源根走，两种平台分隔符都对", () => {
  assert.equal(
    pdfSkillFile({ FASTVIBE_RESOURCES_PATH: "/app/resources" } as NodeJS.ProcessEnv),
    "/app/resources/skills/pdf/SKILL.md",
  );
  // 尾部斜杠不能拼出双斜杠
  assert.equal(
    pdfSkillFile({ FASTVIBE_RESOURCES_PATH: "/app/resources/" } as NodeJS.ProcessEnv),
    "/app/resources/skills/pdf/SKILL.md",
  );
  assert.equal(
    pdfSkillFile({ FASTVIBE_RESOURCES_PATH: "C:\\App\\resources" } as NodeJS.ProcessEnv),
    "C:\\App\\resources\\skills\\pdf\\SKILL.md",
  );
  // 资源根没设时返回 undefined，调用方退化成不带路径的说法
  assert.equal(pdfSkillFile({} as NodeJS.ProcessEnv), undefined);
});
