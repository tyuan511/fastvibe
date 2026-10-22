import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DefaultResourceLoader, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { SkillDraft, SkillInfo, SkillMarketInstallResult, SkillMarketTarget } from "@shared/types";
import { stageMarketSkill } from "../engine/skills-market";
import { builtinSkillPaths } from "./extension-manager";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Where a skills.sh download is unpacked before it is moved into `skills/`. */
const MARKET_STAGING_DIR = "market-staging";
/** A market install that died halfway leaves a staging tree; nobody is coming for it. */
const STALE_STAGING_MS = 12 * 60 * 60 * 1000;

export class SkillManager {
  #agentDir: string;
  #skillsDir: string;

  constructor(agentDir: string, skillsDir: string) {
    this.#agentDir = agentDir;
    this.#skillsDir = skillsDir;
  }

  async list(cwd: string): Promise<SkillInfo[]> {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.#agentDir,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: builtinSkillPaths(),
    });
    await loader.reload();
    return loader.getSkills().skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      // Built-ins are passed through the SDK's additionalSkillPaths API, which
      // marks them as temporary CLI resources. That describes the loader
      // lifetime, not where the skill comes from in FastVibe's UI.
      scope: skill.sourceInfo.scope === "temporary" ? "system" : skill.sourceInfo.scope,
      source: skill.sourceInfo.source,
      removable: isManagedSkill(this.#skillsDir, skill.baseDir),
    }));
  }

  async create(cwd: string, draft: SkillDraft): Promise<SkillInfo[]> {
    const name = normalizeSkillName(draft.name);
    const description = draft.description.trim();
    if (!description) throw new Error("请填写技能说明");
    if (description.length > 1024) throw new Error("说明不能超过 1024 个字符");
    const dest = join(this.#skillsDir, name);
    if (existsSync(dest)) throw new Error(`技能 ${name} 已存在`);
    await mkdir(dest, { recursive: true });
    const body = draft.body.trim();
    const content = `---\nname: ${name}\ndescription: ${yamlString(description)}\n---\n\n${body || `# ${name}\n`}\n`;
    await writeFile(join(dest, "SKILL.md"), content, "utf8");
    return this.list(cwd);
  }

  async importFrom(cwd: string, sourceDir: string): Promise<SkillInfo[]> {
    const resolved = resolve(sourceDir);
    if (!existsSync(resolved)) throw new Error("所选文件夹不存在");
    if (isSameOrInside(this.#skillsDir, resolved)) throw new Error("该技能已在列表中");
    const discovered = loadSkillsFromDir({ dir: resolved, source: "user" }).skills;
    if (discovered.length === 0) throw new Error("所选文件夹没有 SKILL.md");
    for (const skill of discovered) {
      const dest = join(this.#skillsDir, skill.name);
      if (existsSync(dest)) throw new Error(`技能 ${skill.name} 已存在`);
    }
    for (const skill of discovered) {
      const dest = join(this.#skillsDir, skill.name);
      await cp(skill.baseDir, dest, { recursive: true });
    }
    return this.list(cwd);
  }

  async remove(cwd: string, name: string): Promise<SkillInfo[]> {
    const skills = await this.list(cwd);
    const skill = skills.find((item) => item.name === name);
    if (!skill) throw new Error("技能不存在");
    if (!skill.removable) throw new Error("只能删除 FastVibe 中添加的技能");
    await rm(skill.baseDir, { recursive: true, force: true });
    return this.list(cwd);
  }

  /**
   * Install a skill straight from skills.sh.
   *
   * The download and the archive walk happen in a staging directory beside the skills
   * themselves, and only a complete, verified skill is moved into place — so a killed
   * connection or a repository that turns out not to hold the skill leaves the existing
   * list exactly as it was.
   */
  async installFromMarket(cwd: string, target: SkillMarketTarget): Promise<SkillMarketInstallResult> {
    const root = join(this.#agentDir, MARKET_STAGING_DIR);
    await this.#sweepStaleStaging(root);
    const staging = join(root, randomUUID());
    try {
      const staged = await stageMarketSkill(target, staging);
      const skills = await this.installStaged(cwd, staged, { replace: Boolean(target.overwrite) });
      return { skills, installed: { name: staged.name, source: target.source, files: staged.files, skipped: staged.skipped } };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Put a staged skill into FastVibe's own skills directory.
   *
   * A name that already exists is refused unless the caller asked to replace it **and*
   * the existing copy is ours. The SDK dedupes skills by name and keeps whichever it
   * loaded first, so quietly writing a second copy of a name is how an install becomes a
   * no-op that reports success — and a built-in, a project's, or the user's own
   * `~/.agents/skills` entry is not something this app owns.
   */
  async installStaged(
    cwd: string,
    staged: { dir: string; name: string },
    options: { replace: boolean },
  ): Promise<SkillInfo[]> {
    const skills = await this.list(cwd);
    const dest = join(this.#skillsDir, staged.name);
    const clash = skills.find((item) => item.name === staged.name || item.baseDir === dest);
    if (clash) {
      if (!clash.removable) throw new Error(`已有同名技能 ${staged.name}，它不是 FastVibe 装的，不会被覆盖`);
      if (!options.replace) throw new Error(`技能 ${staged.name} 已存在，可选择覆盖安装`);
    }
    await mkdir(this.#skillsDir, { recursive: true });
    if (!clash) {
      // A directory an interrupted install left behind is not a skill the list knows
      // about; it must not make the retry impossible.
      if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
      await rename(staged.dir, dest);
      return this.list(cwd);
    }
    const backup = `${dest}.replacing-${Date.now()}`;
    await rename(dest, backup);
    try {
      await rename(staged.dir, dest);
    } catch (error) {
      await rename(backup, dest).catch(() => undefined);
      throw error;
    }
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    return this.list(cwd);
  }

  /** Best effort: an abandoned staging tree costs a few megabytes on the data volume. */
  async #sweepStaleStaging(root: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(root, name);
      try {
        if (Date.now() - (await stat(path)).mtimeMs > STALE_STAGING_MS) await rm(path, { recursive: true, force: true });
      } catch {
        // Somebody else is mid-install in that directory; leaving it is the right answer.
      }
    }
  }
}

export function normalizeSkillName(value: string): string {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!name || !NAME_PATTERN.test(name)) throw new Error("名称需为小写字母、数字和连字符");
  return name;
}

function yamlString(value: string): string {
  if (/[\n\r:#{}[\],&*?|>!%@`'"\\]/.test(value) || value !== value.trim()) return JSON.stringify(value);
  return value;
}

function isManagedSkill(skillsDir: string, skillDir: string): boolean {
  return isInside(skillsDir, skillDir);
}

function isInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  if (target === root) return false;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

function isSameOrInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}
