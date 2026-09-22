import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Loading03Icon,
  Plug01Icon,
} from "@hugeicons/core-free-icons";
import { IconButton } from "@/components/icon-button";
import { Badge } from "@/components/ui/badge";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { McpServerConfig, McpServerStatus } from "@shared/types";

/** The add-server form's draft; also doubles as the dialog's open state. */
type ServerDraft = {
  name: string;
  transport: McpServerConfig["transport"];
  command: string;
  args: string;
  url: string;
  enabled: boolean;
};

const EMPTY_DRAFT: ServerDraft = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  enabled: true,
};

export function McpSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      setServers(await window.fastvibe.engine.listMcpServers());
    } catch {
      setServers([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  /** Never throws: callers act on the boolean so row edits cannot produce an
   *  unhandled rejection, and failures surface in the same `error` the dialog uses. */
  async function save(next: McpServerConfig[]): Promise<boolean> {
    setSaving(true);
    try {
      setServers(await window.fastvibe.engine.saveMcpServers(next));
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mcp.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function patchDraft(next: Partial<ServerDraft>): void {
    setDraft((current) => (current ? { ...current, ...next } : current));
  }

  const valid = Boolean(
    draft &&
      draft.name.trim() &&
      (draft.transport === "stdio" ? draft.command.trim() : draft.url.trim()),
  );

  async function submit(): Promise<void> {
    if (!draft || !valid) return;
    const name = draft.name.trim();
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
    const config: McpServerConfig = {
      id,
      name,
      enabled: draft.enabled,
      transport: draft.transport,
      ...(draft.transport === "stdio"
        ? { command: draft.command.trim(), args: parseArgs(draft.args) }
        : { url: draft.url.trim() }),
    };
    if (await save([...servers, { ...config, connected: false, tools: [] }])) setDraft(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{t("mcp.configured")}</span>
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            setError(null);
            setDraft({ ...EMPTY_DRAFT });
          }}
        >
          <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
          {t("mcp.add")}
        </Button>
      </div>

      {servers.length ? (
        <div className="grid gap-2.5">
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              onToggle={(enabled) =>
                void save(servers.map((item) => (item.id === server.id ? { ...item, enabled } : item)))
              }
              onRemove={() => void save(servers.filter((item) => item.id !== server.id))}
            />
          ))}
        </div>
      ) : (
        <Empty className="border border-dashed border-border py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon strokeWidth={2} icon={Plug01Icon} />
            </EmptyMedia>
            <EmptyTitle>{t("mcp.empty")}</EmptyTitle>
            <EmptyDescription>{t("mcp.emptyHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {/* Row-level failures have nowhere else to show; the dialog renders its own copy. */}
      {error && draft === null ? <p className="text-xs text-destructive">{error}</p> : null}

      <AddServerDialog
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

function ServerRow({
  server,
  onToggle,
  onRemove,
}: {
  server: McpServerStatus;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const status = server.connected ? (
    <Badge variant="secondary" className="shrink-0">
      <HugeiconsIcon strokeWidth={2} icon={CheckmarkCircle02Icon} className="size-3" />
      {t("mcp.tools", { count: server.tools.length })}
    </Badge>
  ) : server.error ? (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} aria-label={t("mcp.errorDetails")} className="shrink-0 outline-none" />}
      >
        <Badge variant="destructive" className="cursor-help">
          <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} className="size-3" />
          {t("mcp.connectFailed")}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-96 whitespace-normal">
        <div className="space-y-1 text-left">
          <p className="font-medium">{t("mcp.errorDetails")}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{server.error}</pre>
        </div>
      </TooltipContent>
    </Tooltip>
  ) : (
    <Badge variant="outline" className="shrink-0">
      <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} className="size-3" />
      {t("mcp.disconnected")}
    </Badge>
  );

  return (
    <Item
      variant="outline"
      size="sm"
      className="items-start gap-3 bg-card/80 p-3 transition-colors hover:border-primary/30 hover:bg-muted/20"
    >
      <ItemMedia
        variant="icon"
        className="mt-0.5 size-9 rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15"
      >
        <HugeiconsIcon strokeWidth={2} icon={Plug01Icon} className="size-4" />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <ItemTitle title={server.name} className="min-w-0 truncate text-base">
            {server.name}
          </ItemTitle>
          {status}
        </div>
        <ItemDescription className="line-clamp-1" title={server.error ?? undefined}>
          {server.error ??
            (server.transport === "stdio"
              ? `${server.command ?? ""} ${(server.args ?? []).join(" ")}`
              : server.url)}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="ml-auto shrink-0 self-center">
        <Switch checked={server.enabled} onCheckedChange={onToggle} />
        <IconButton label={t("mcp.delete")} size="icon-xs" variant="ghost" onClick={onRemove}>
          <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
        </IconButton>
      </ItemActions>
    </Item>
  );
}

/** The add form lives in a dialog so the list keeps the whole pane. */
function parseArgs(value: string): string[] | undefined {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of value.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (escaped) current += "\\";
  if (current) args.push(current);
  return args.length ? args : undefined;
}

function AddServerDialog({
  draft,
  saving,
  error,
  valid,
  onPatch,
  onClose,
  onSubmit,
}: {
  draft: ServerDraft | null;
  saving: boolean;
  error: string | null;
  valid: boolean;
  onPatch: (next: Partial<ServerDraft>) => void;
  onClose: () => void;
  onSubmit: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("mcp.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("mcp.dialogDesc")}</DialogDescription>
        </DialogHeader>

        {draft ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("mcp.name")}</Label>
                <Input
                  autoFocus
                  value={draft.name}
                  placeholder={t("mcp.namePlaceholder")}
                  onChange={(event) => onPatch({ name: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("mcp.transport")}</Label>
                <select
                  value={draft.transport}
                  onChange={(event) => onPatch({ transport: event.target.value as McpServerConfig["transport"] })}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="stdio">{t("mcp.stdio")}</option>
                  <option value="http">HTTP（Streamable HTTP）</option>
                </select>
              </div>
            </div>

            {draft.transport === "stdio" ? (
              <>
                <div className="space-y-1.5">
                  <Label>{t("mcp.command")}</Label>
                  <Input
                    value={draft.command}
                    placeholder="npx"
                    onChange={(event) => onPatch({ command: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("mcp.args")}</Label>
                  <Input
                    value={draft.args}
                    placeholder="-y @modelcontextprotocol/server-filesystem /Users/me/project"
                    onChange={(event) => onPatch({ args: event.target.value })}
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                <Label>URL</Label>
                <Input
                  value={draft.url}
                  placeholder="https://example.com/mcp"
                  onChange={(event) => onPatch({ url: event.target.value })}
                />
              </div>
            )}

            <div className="flex items-center gap-2 text-xs">
              <Switch checked={draft.enabled} onCheckedChange={(checked) => onPatch({ enabled: checked })} />
              {t("mcp.enableAfter")}
            </div>
          </div>
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("mcp.cancel")}
          </Button>
          <Button disabled={!valid || saving} onClick={onSubmit}>
            {saving ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
            {t("mcp.addConnect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
