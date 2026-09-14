import { useEffect, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Delete02Icon,
  Folder01Icon,
  Loading03Icon,
  MagicWand02Icon,
  MoreHorizontalIcon,
  RefreshIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "@/components/icon-button";
import type { SkillDraft, SkillInfo } from "@shared/types";

const EMPTY_DRAFT: SkillDraft = { name: "", description: "", body: "" };

export function SkillsSettings(): JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      setSkills(await window.fastvibe.engine.listSkills());
    } catch {
      setSkills([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function patchDraft(next: Partial<SkillDraft>): void {
    setDraft((current) => (current ? { ...current, ...next } : current));
  }

  const valid = Boolean(draft && draft.name.trim() && draft.description.trim());
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle),
      )
    : skills;

  async function submit(): Promise<void> {
    if (!draft || !valid) return;
    setSaving(true);
    try {
      setSkills(await window.fastvibe.engine.createSkill(draft));
      setError(null);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  async function importSkill(): Promise<void> {
    setSaving(true);
    try {
      const next = await window.fastvibe.engine.importSkill();
      if (next) {
        setSkills(next);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  async function remove(name: string): Promise<void> {
    setSaving(true);
    try {
      setSkills(await window.fastvibe.engine.removeSkill(name));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  function openCreate(): void {
    setError(null);
    setDraft({ ...EMPTY_DRAFT });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <InputGroup className="w-64 rounded-full">
          <InputGroupAddon>
            <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            placeholder="搜索技能..."
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium">已安装 {skills.length}</span>
        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" variant="outline" />}>
              <HugeiconsIcon strokeWidth={2} icon={MoreHorizontalIcon} />
              <span className="sr-only">更多</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={saving} onClick={() => void importSkill()}>
                <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
                导入文件夹
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <IconButton
            label="刷新"
            size="icon-sm"
            variant="outline"
            disabled={saving}
            onClick={() => void refresh()}
          >
            <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
          </IconButton>
          <Button size="sm" disabled={saving} onClick={openCreate}>
            <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
            新建
          </Button>
        </div>
      </div>

      {visible.length ? (
        <ItemGroup className="gap-0! overflow-hidden rounded-xl bg-muted">
          {visible.map((skill, index) => (
            <div key={`${skill.scope}:${skill.filePath}`}>
              {index > 0 ? <Separator /> : null}
              <SkillRow skill={skill} onRemove={() => void remove(skill.name)} />
            </div>
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border border-dashed border-border py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon strokeWidth={2} icon={MagicWand02Icon} />
            </EmptyMedia>
            <EmptyTitle>{skills.length ? "没有匹配的技能" : "尚未安装技能"}</EmptyTitle>
            <EmptyDescription>
              {skills.length ? "试试其他关键词" : "新建或导入文件夹后会出现在这里"}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {error && draft === null ? <p className="text-xs text-destructive">{error}</p> : null}

      <AddSkillDialog
        draft={draft}
        saving={saving}
        error={error}
        valid={valid}
        onPatch={patchDraft}
        onClose={() => setDraft(null)}
        onSubmit={() => void submit()}
      />
    </div>
  );
}

function SkillRow({ skill, onRemove }: { skill: SkillInfo; onRemove: () => void }): JSX.Element {
  return (
    <Item size="sm" className="rounded-none px-3 py-2.5">
      <ItemMedia className="self-center translate-y-0">
        <span className="flex size-9 items-center justify-center rounded-full bg-background text-muted-foreground">
          <HugeiconsIcon strokeWidth={2} icon={MagicWand02Icon} className="size-4" />
        </span>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="font-medium">{skill.name}</ItemTitle>
        <ItemDescription className="line-clamp-1">{skill.description}</ItemDescription>
      </ItemContent>
      {skill.removable ? (
        <ItemActions>
          <IconButton label="删除技能" size="icon-xs" variant="ghost" onClick={onRemove}>
            <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
          </IconButton>
        </ItemActions>
      ) : null}
    </Item>
  );
}

function AddSkillDialog({
  draft,
  saving,
  error,
  valid,
  onPatch,
  onClose,
  onSubmit,
}: {
  draft: SkillDraft | null;
  saving: boolean;
  error: string | null;
  valid: boolean;
  onPatch: (next: Partial<SkillDraft>) => void;
  onClose: () => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加技能</DialogTitle>
          <DialogDescription>写入 FastVibe 的全局技能目录，新会话会自动加载。</DialogDescription>
        </DialogHeader>

        {draft ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input
                autoFocus
                value={draft.name}
                placeholder="my-skill"
                onChange={(event) => onPatch({ name: event.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">小写字母、数字和连字符</p>
            </div>
            <div className="space-y-1.5">
              <Label>说明</Label>
              <Textarea
                value={draft.description}
                placeholder="这个技能做什么，以及何时使用"
                className="min-h-16 resize-y"
                onChange={(event) => onPatch({ description: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>指令</Label>
              <Textarea
                value={draft.body}
                placeholder="完整步骤、命令和注意事项。相对路径相对于技能目录。"
                className="min-h-32 resize-y"
                onChange={(event) => onPatch({ body: event.target.value })}
              />
            </div>
          </div>
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!valid || saving} onClick={onSubmit}>
            {saving ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
