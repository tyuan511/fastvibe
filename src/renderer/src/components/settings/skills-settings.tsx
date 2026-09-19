import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
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
import { Badge } from "@/components/ui/badge";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "@/components/icon-button";
import type { SkillDraft, SkillInfo } from "@shared/types";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";

const EMPTY_DRAFT: SkillDraft = { name: "", description: "", body: "" };

export function SkillsSettings(): JSX.Element {
  const { t } = useTranslation("settings");
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
      setError(err instanceof Error ? err.message : t("skills.addFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function importSkill(): Promise<void> {
    // A folder dialog, on the host's screen. 新建 beside it writes through a call and
    // works from anywhere.
    if (blockedRemotely(Ipc.engineImportSkill)) return;
    setSaving(true);
    try {
      const next = await window.fastvibe.engine.importSkill();
      if (next) {
        setSkills(next);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("skills.importFailed"));
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
      setError(err instanceof Error ? err.message : t("skills.deleteFailed"));
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
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{t("skills.installed", { count: skills.length })}</span>
        <div className="flex items-center gap-1.5">
          <InputGroup className="h-8 w-56 rounded-full">
            <InputGroupAddon>
              <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              placeholder={t("skills.search")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" variant="outline" />}>
              <HugeiconsIcon strokeWidth={2} icon={MoreHorizontalIcon} />
              <span className="sr-only">{t("skills.more")}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={saving} onClick={() => void importSkill()}>
                <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
                {t("skills.importFolder")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <IconButton
            label={t("skills.refresh")}
            size="icon-sm"
            variant="outline"
            disabled={saving}
            onClick={() => void refresh()}
          >
            <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
          </IconButton>
          <Button size="sm" disabled={saving} onClick={openCreate}>
            <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
            {t("skills.create")}
          </Button>
        </div>
      </div>

      {visible.length ? (
        <div className="grid gap-2.5">
          {visible.map((skill) => (
            <SkillCard
              key={`${skill.scope}:${skill.filePath}`}
              skill={skill}
              onRemove={() => void remove(skill.name)}
            />
          ))}
        </div>
      ) : (
        <Empty className="border border-dashed border-border py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon strokeWidth={2} icon={MagicWand02Icon} />
            </EmptyMedia>
            <EmptyTitle>{skills.length ? t("skills.noneMatch") : t("skills.none")}</EmptyTitle>
            <EmptyDescription>
              {skills.length ? t("skills.tryOther") : t("skills.emptyHint")}
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

function SkillCard({ skill, onRemove }: { skill: SkillInfo; onRemove: () => void }): JSX.Element {
  const { t } = useTranslation("settings");
  const scopeLabel =
    skill.scope === "project"
      ? t("skills.scopeProject")
      : skill.scope === "temporary"
        ? t("skills.scopeTemporary")
        : t("skills.scopeGlobal");
  return (
    <Item variant="outline" size="sm" className="items-start gap-3 bg-card/80 p-3 transition-colors hover:border-primary/30 hover:bg-muted/20">
      <ItemMedia variant="icon" className="mt-0.5 size-9 rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
        <HugeiconsIcon strokeWidth={2} icon={MagicWand02Icon} className="size-4" />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <ItemTitle title={skill.name} className="min-w-0 truncate text-base">{skill.name}</ItemTitle>
          <Badge variant="secondary" className="shrink-0">{scopeLabel}</Badge>
        </div>
        <ItemDescription className="line-clamp-1">{skill.description}</ItemDescription>
      </ItemContent>
      {skill.removable ? (
        <ItemActions className="ml-auto shrink-0 self-center">
          <IconButton label={t("skills.delete")} size="icon-xs" variant="ghost" onClick={onRemove}>
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
  const { t } = useTranslation("settings");
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("skills.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("skills.dialogDesc")}</DialogDescription>
        </DialogHeader>

        {draft ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("skills.name")}</Label>
              <Input
                autoFocus
                value={draft.name}
                placeholder="my-skill"
                onChange={(event) => onPatch({ name: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("skills.nameHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t("skills.description")}</Label>
              <Textarea
                value={draft.description}
                placeholder={t("skills.descriptionPlaceholder")}
                className="min-h-16 resize-y"
                onChange={(event) => onPatch({ description: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("skills.instructions")}</Label>
              <Textarea
                value={draft.body}
                placeholder={t("skills.instructionsPlaceholder")}
                className="min-h-32 resize-y"
                onChange={(event) => onPatch({ body: event.target.value })}
              />
            </div>
          </div>
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("skills.cancel")}
          </Button>
          <Button disabled={!valid || saving} onClick={onSubmit}>
            {saving ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
            {t("skills.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
