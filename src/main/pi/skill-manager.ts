import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DefaultResourceLoader, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { SkillDraft, SkillInfo } from "@shared/types";
import { builtinSkillPaths } from "./extension-manager";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
      scope: skill.sourceInfo.scope,
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
