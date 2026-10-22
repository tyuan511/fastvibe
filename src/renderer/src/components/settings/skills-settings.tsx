import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Folder01Icon,
  MagicWand02Icon,
  RefreshIcon,
  Search01Icon,
  Store01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { IconButton } from "@/components/icon-button";
import { SkillsMarketDialog } from "@/components/settings/skills-market-dialog";
import type { SkillInfo } from "@shared/types";

export function SkillsSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [market, setMarket] = useState(false);

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

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle),
      )
    : skills;

  async function importSkill(): Promise<void> {
    // A folder dialog, on the host's screen. 新建 beside it writes through a call and
    // works from anywhere.
    setSaving(true);
    try {
      const next = await window.fastvibe.engine.importSkill();
      if (next) {
        setSkills(next);
        toast.success(t("skills.importDone"));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("skills.importFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(name: string): Promise<void> {
    setSaving(true);
    try {
      setSkills(await window.fastvibe.engine.removeSkill(name));
      toast.success(t("skills.deleteDone", { name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("skills.deleteFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="text-sm font-medium">{t("skills.installed", { count: skills.length })}</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5">
          <InputGroup className="h-8 w-56 max-w-full rounded-full">
            <InputGroupAddon>
              <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              placeholder={t("skills.search")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          <IconButton
            label={t("skills.refresh")}
            size="icon-sm"
            variant="outline"
            disabled={saving}
            onClick={() => void refresh()}
          >
            <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
          </IconButton>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => setMarket(true)}>
            <HugeiconsIcon strokeWidth={2} icon={Store01Icon} />
            {t("skills.market")}
          </Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void importSkill()}>
            <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
            {t("skills.import")}
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

      <SkillsMarketDialog
        open={market}
        installed={skills}
        onClose={() => setMarket(false)}
        onInstalled={(result) => setSkills(result.skills)}
      />
    </div>
  );
}

function SkillCard({ skill, onRemove }: { skill: SkillInfo; onRemove: () => void }): JSX.Element {
  const { t } = useTranslation("settings");
  const scopeLabel =
    skill.scope === "project"
      ? t("skills.scopeProject")
      : skill.scope === "system"
        ? t("skills.scopeSystem")
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
