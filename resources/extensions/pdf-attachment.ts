import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * PDF 附件 → 强制走 `pdf` 技能。
 *
 * 模型看附件只能看到一个文件路径。`report.pdf` 这个名字不足以让它想起「我有一份
 * 专门讲 PDF 的说明」，而那份说明（`resources/skills/pdf`）里的库选择、坐标系
 * 换算、可填表单与扁平表单的两条路，恰恰是凭直觉最容易做错的地方——尤其是
 * 「值写进去了但没显示」和「字压到框线上」这两种失败。
 *
 * 所以附件里有 PDF 时，由宿主把这条提醒直接放进系统提示，不指望模型自己意识到。
 * 这是 `before_agent_start` 的职责：它每次用户提示前触发一次，`event.prompt` 是
 * 引擎最终收到的完整文本（含宿主追加的 `<fastvibe-attachments>` 路径块）。
 *
 * 三条设计取舍：
 *
 * - **检测逻辑内联在这个文件里，不 import 仓库模块。** 扩展是 jiti 独立模块，
 *   打包后住在 `resourcesPath/extensions`，旁边没有 `src/`，任何 `@shared/*`
 *   或相对仓库路径的 import 都会在打包版里炸掉。这也是 `permission-sandbox.ts`
 *   把规则写在自己文件里的同一个理由。为了让单测能覆盖，判断函数是导出的。
 * - **只按名字和 MIME 判断，不读文件。** 提示词组装时文件可能还没落盘，也可能在
 *   另一台机器上（远程访问）。宁可多提醒一次，也不要因为元数据不全而漏掉。
 * - **提醒只说「用这个技能」，不复述技能内容。** 技能本身按需读取；把它的正文抄进
 *   系统提示既浪费上下文，又会在技能更新后变成过期副本。
 */

/** 扩展名按 `.pdf` 判断，大小写都认（Windows 上 `.PDF` 很常见）。 */
const PDF_EXTENSIONS = [".pdf"];

/** MIME 白名单。浏览器偶尔给 `application/x-pdf`。 */
const PDF_MIME_TYPES = new Set(["application/pdf", "application/x-pdf"]);

const T = (zh: string, en: string): string => (process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh);

/** 后缀判断，容忍查询串（从 URL 粘来的路径会带 `?x=1`）。 */
export function hasPdfExtension(path: string): boolean {
  const withoutQuery = path.split(/[?#]/)[0];
  const lower = withoutQuery.toLowerCase();
  return PDF_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** MIME 判断，参数部分（`; charset=…`）不参与比较。 */
export function isPdfMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return PDF_MIME_TYPES.has(mimeType.split(";")[0].trim().toLowerCase());
}

/** 一个附件的四个字段就够判断了——正是 `ChatAttachment` 的子集。 */
export type PdfCandidate = {
  kind?: string;
  name?: string;
  mimeType?: string;
  path?: string;
};

/**
 * 这个附件是不是 PDF。
 *
 * 三条线索任一命中即可：MIME 明确说是 PDF、名字以 `.pdf` 结尾、路径以 `.pdf` 结尾。
 * **不校验扩展名和 MIME 是否一致**：拖进来的文件常常 MIME 缺失或写成
 * `application/octet-stream`，而名字是对的。多提醒一次的成本远低于漏掉。
 */
export function isPdfAttachment(item: PdfCandidate): boolean {
  if (isPdfMimeType(item.mimeType)) return true;
  if (item.name && hasPdfExtension(item.name)) return true;
  if (item.path && hasPdfExtension(item.path)) return true;
  return false;
}

/**
 * 剥掉包裹路径的引号、括号和尾部标点。
 *
 * 反复剥离而不是各剥一次，是因为两者会交替出现：`"a.pdf".` 先剥前引号得到
 * `a.pdf".`，此时尾部是 `.`，剥掉后才露出那个后引号。一次不够。
 */
function trimPathDecoration(value: string): string {
  let current = value;
  for (let i = 0; i < 8; i += 1) {
    const next = current
      .replace(/^[\s"'`(<[（【]+/, "")
      .replace(/[\s"'`>)\]）】]+$/, "")
      .replace(/[.,;:!?，。；：！？、]+$/, "");
    if (next === current) break;
    current = next;
  }
  return current;
}

const OPEN_BRACKETS = "(（[【";
const CLOSE_BRACKETS = ")）]】";

/**
 * 切掉括号两侧粘着的正文：`看看（附件.pdf）吧` → `附件.pdf`。
 *
 * 中文句子不用空格断词，括号外的字和路径连在一起。右侧：扩展名后面紧跟右括号，
 * 就从扩展名处截断。左侧：从尾部往回找第一个没配对的左括号，从它后面切——配对的
 * 括号是文件名的一部分，`报告（2024）.pdf` 不能被切成 `2024）.pdf`。
 */
function cutSurroundingProse(input: string): string {
  const closed = /\.pdf(?=[)）\]】])/i.exec(input);
  const value = closed ? input.slice(0, closed.index + ".pdf".length) : input;
  let depth = 0;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const char = value[i];
    if (CLOSE_BRACKETS.includes(char)) depth += 1;
    else if (OPEN_BRACKETS.includes(char)) {
      if (depth === 0) return value.slice(i + 1);
      depth -= 1;
    }
  }
  return value;
}

/**
 * 从一段文本里找出被当成文件路径引用的 PDF。
 *
 * 覆盖用户手写的路径（`看看 /tmp/a.pdf`）和宿主追加的附件块。只做后缀匹配，
 * **不检查文件是否存在**。
 */
export function pdfPathsInText(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  // 按空白切分还不够：中文句子里路径后面直接跟全角标点和下一句话
  // （`Q3.pdf，另外`），所以全角句读和引号也当分隔符。半角 `:` 不算——
  // URL 和 `C:\` 里都有它。然后逐段剥掉引号、括号和尾部标点。
  for (const raw of text.split(/[\s，。；：！？、“”‘’「」『』《》]+/)) {
    const candidate = cutSurroundingProse(trimPathDecoration(raw));
    if (!candidate || !hasPdfExtension(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
  }
  return found;
}

/**
 * 这一回合涉及哪些 PDF（去重、保序）。空数组表示不涉及。
 *
 * 返回路径而不是布尔，是因为提醒里要点名具体文件——否则模型还得回去翻附件列表。
 * 结构化附件和提示词文本都看：附件来自本机 UI，而提示词里可能还有用户手写的路径
 * （比如从远程客户端发来的消息，那边没有文件系统）。
 */
export function pdfTurnPaths(prompt: string, attachments: readonly PdfCandidate[] = []): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined): void => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    found.push(value);
  };

  for (const item of attachments) {
    if (isPdfAttachment(item)) push(item.path ?? item.name);
  }
  for (const path of pdfPathsInText(prompt)) push(path);

  return found;
}

/** 系统提示里那段提醒。点名文件，并给出技能的读取路径。 */
export function pdfReminder(paths: readonly string[], skillFile: string): string {
  const list = paths.map((path) => `- ${path}`).join("\n");
  const zh = [
    "本回合有 PDF 文件需要处理。**先读 `" + skillFile + "` 再动手**——里面写了该用哪个库、",
    "坐标系怎么换算、以及可填表单和扁平表单是两条完全不同的路（走错会得到「值写进去了",
    "但显示不出来」或「字压到框线上」）。",
    "",
    "涉及的 PDF：",
    list,
  ].join("\n");
  const en = [
    "This turn involves PDF files. **Read `" + skillFile + "` before you start** — it says which",
    "library to use, how to convert coordinates, and that fillable and flat forms are two",
    "completely different paths (guessing wrong gives you a value that never renders, or text",
    "printed on top of the box borders).",
    "",
    "PDFs in this turn:",
    list,
  ].join("\n");
  return T(zh, en);
}

/**
 * 技能文件的位置。宿主把 `FASTVIBE_RESOURCES_PATH` 指到 `resources/`（开发）或
 * `resourcesPath/`（打包），内置技能在它下面的 `skills/`。这个变量由 Main 在
 * 启动时设好，和 `builtinSkillPaths()` 读的是同一个。
 */
export function pdfSkillFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env.FASTVIBE_RESOURCES_PATH?.trim();
  if (!root) return undefined;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}skills${separator}pdf${separator}SKILL.md`;
}

export default function pdfAttachment(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    // `event.images` 里不会有 PDF（图片附件是 image/*），所以只看 prompt。
    // 结构化附件不走这个事件——它们已经被渲染进 prompt 的路径块里了。
    const paths = pdfTurnPaths(event.prompt);
    if (paths.length === 0) return;

    const skillFile = pdfSkillFile();
    const reminder = skillFile
      ? pdfReminder(paths, skillFile)
      : // 理论上到不了这里（Main 启动时一定设了资源根）。真到了也不能让这一回合
        // 失去提醒——退化成不带路径的说法，模型仍然能从技能列表里找到 `pdf`。
        T(
          "本回合有 PDF 文件需要处理。先读 `pdf` 技能的 SKILL.md 再动手。",
          "This turn involves PDF files. Read the `pdf` skill's SKILL.md before you start.",
        );

    return { systemPrompt: `${event.systemPrompt}\n\n${reminder}` };
  });
}
