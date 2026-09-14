import { useEffect, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Loading03Icon,
  Plug01Icon,
} from "@hugeicons/core-free-icons";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
      setError(err instanceof Error ? err.message : "保存失败，请重试");
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
        ? { command: draft.command.trim(), args: draft.args.trim() ? draft.args.trim().split(/\s+/) : undefined }
        : { url: draft.url.trim() }),
    };
    if (await save([...servers, { ...config, connected: false, tools: [] }])) setDraft(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-muted-foreground">已配置</span>
        <Button size="xs" variant="outline" onClick={() => { setError(null); setDraft({ ...EMPTY_DRAFT }); }}>
          <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
          添加服务器
        </Button>
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        {servers.length ? (
          servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              onToggle={(enabled) =>
                void save(servers.map((item) => (item.id === server.id ? { ...item, enabled } : item)))
              }
              onRemove={() => void save(servers.filter((item) => item.id !== server.id))}
            />
          ))
        ) : (
          <p className="py-3 text-center text-xs text-muted-foreground">尚未配置 MCP 服务器</p>
        )}
        {/* Row-level failures have nowhere else to show; the dialog renders its own copy. */}
        {error && draft === null ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

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
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/70 px-3 py-2.5">
      <HugeiconsIcon strokeWidth={2} icon={Plug01Icon} className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{server.name}</p>
        <p className="truncate text-[11px] text-muted-foreground" title={server.error ?? undefined}>
          {server.error ??
            (server.transport === "stdio"
              ? `${server.command ?? ""} ${(server.args ?? []).join(" ")}`
              : server.url)}
        </p>
      </div>
      {server.connected ? (
        <Badge variant="secondary">
          <HugeiconsIcon strokeWidth={2} icon={CheckmarkCircle02Icon} className="size-3" />
          {server.tools.length} 个工具
        </Badge>
      ) : (
        <Badge variant={server.error ? "destructive" : "outline"}>
          <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} className="size-3" />
          {server.error ? "连接失败" : "未连接"}
        </Badge>
      )}
      <Switch checked={server.enabled} onCheckedChange={onToggle} />
      <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label="删除服务器">
        <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
      </Button>
    </div>
  );
}

/** The add form lives in a dialog so the list keeps the whole pane. */
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
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加 MCP 服务器</DialogTitle>
          <DialogDescription>支持本地进程（stdio）与 HTTP 两种传输。</DialogDescription>
        </DialogHeader>

        {draft ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>名称</Label>
                <Input
                  autoFocus
                  value={draft.name}
                  placeholder="例如 filesystem"
                  onChange={(event) => onPatch({ name: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>传输</Label>
                <select
                  value={draft.transport}
                  onChange={(event) => onPatch({ transport: event.target.value as McpServerConfig["transport"] })}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="stdio">本地进程（stdio）</option>
                  <option value="http">HTTP（Streamable HTTP）</option>
                </select>
              </div>
            </div>

            {draft.transport === "stdio" ? (
              <>
                <div className="space-y-1.5">
                  <Label>命令</Label>
                  <Input
                    value={draft.command}
                    placeholder="npx"
                    onChange={(event) => onPatch({ command: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>参数（空格分隔）</Label>
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
              添加后启用
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
            添加并连接
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
