import { useEffect, useState, type JSX } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Edit02Icon,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMap, mergeServers, parseMap, parseMcpJson, serializeMcpJson, type McpJsonError } from "@shared/mcp-config";
import type { McpExposure, McpServerConfig, McpServerStatus } from "@shared/types";

/**
 * The server form's draft; also doubles as the dialog's open state. `id` is set while
 * editing a stored server and absent while adding one. `env` and `headers` are the text
 * the user types (see `shared/mcp-config.ts`), parsed only when the form is submitted.
 *
 * The dialog has two views of one server: the fields, and the standard `mcpServers` JSON
 * (`json`). Only the one on screen is read on submit; switching converts between them.
 */
type ServerDraft = {
  id?: string;
  view: "form" | "json";
  json: string;
  name: string;
  transport: McpServerConfig["transport"];
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  exposure: McpExposure;
  enabled: boolean;
};

const EMPTY_DRAFT: ServerDraft = {
  view: "form",
  json: "",
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
  exposure: "direct",
  enabled: true,
};

function draftFromServer(server: McpServerConfig): ServerDraft {
  return {
    id: server.id,
    view: "form",
    json: "",
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    args: (server.args ?? []).map(quoteArg).join(" "),
    env: formatMap(server.env, "env"),
    url: server.url ?? "",
    headers: formatMap(server.headers, "headers"),
    exposure: server.exposure ?? "direct",
    enabled: server.enabled,
  };
}

/** The inverse of `parseArgs`, so an edited server round-trips without losing its quoting. */
function quoteArg(arg: string): string {
  return /[\s"'\\]/.test(arg) || arg === "" ? `"${arg.replace(/(["\\])/g, "\\$1")}"` : arg;
}

/** The map the form's active transport edits, and what is wrong with it. */
function draftMap(draft: ServerDraft): ReturnType<typeof parseMap> {
  return draft.transport === "stdio" ? parseMap(draft.env, "env") : parseMap(draft.headers, "headers");
}

/** The server the form currently describes, without judging whether it is complete. */
function configFromDraft(draft: ServerDraft, id: string): McpServerConfig {
  const { values } = draftMap(draft);
  const hasValues = Object.keys(values).length > 0;
  return {
    id,
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: draft.transport,
    ...(draft.transport === "stdio"
      ? { command: draft.command.trim(), args: parseArgs(draft.args), ...(hasValues ? { env: values } : {}) }
      : { url: draft.url.trim(), ...(hasValues ? { headers: values } : {}) }),
    ...(draft.exposure !== "direct" ? { exposure: draft.exposure } : {}),
  };
}

/** A new server's id: readable, and unique even when two share a name. */
function newServerId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
}

/** What is wrong with a pasted config, in the user's language. */
function describeJsonError(t: TFunction, error: McpJsonError): string {
  switch (error.code) {
    case "json":
      return t("mcp.jsonInvalid", { message: error.message });
    case "shape":
      return t("mcp.jsonShape");
    case "missing":
      return t("mcp.jsonMissing", { name: error.name });
    case "sse":
      return t("mcp.jsonSse", { name: error.name });
    case "field":
      return t("mcp.jsonField", { name: error.name, field: error.field });
  }
}

/** The status fields a row carries are not config; they must not be written back to `mcp.json`. */
function toConfig(server: McpServerConfig | McpServerStatus): McpServerConfig {
  const { connected: _connected, tools: _tools, error: _error, ...config } = server as McpServerStatus;
  return config;
}

export function McpSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [saving, setSaving] = useState(false);

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
   *  unhandled rejection, and failures surface as a toast. */
  async function save(next: McpServerConfig[]): Promise<boolean> {
    setSaving(true);
    try {
      setServers(await window.fastvibe.engine.saveMcpServers(next.map(toConfig)));
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("mcp.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function patchDraft(next: Partial<ServerDraft>): void {
    setDraft((current) => (current ? { ...current, ...next } : current));
  }

  const invalidLine = draft && draft.view === "form" ? draftMap(draft).invalid[0] : undefined;
  // Read live, because the JSON view shows what is wrong as it is typed.
  const parsedJson = draft && draft.view === "json" && draft.json.trim() ? parseMcpJson(draft.json) : null;
  const jsonMessages = parsedJson
    ? [
        ...parsedJson.errors.map((error) => describeJsonError(t, error)),
        ...(draft?.id && parsedJson.servers.length > 1 ? [t("mcp.jsonMulti")] : []),
      ]
    : [];
  const valid = Boolean(
    draft &&
      (draft.view === "json"
        ? parsedJson && parsedJson.servers.length > 0 && jsonMessages.length === 0
        : draft.name.trim() &&
          (draft.transport === "stdio" ? draft.command.trim() : draft.url.trim()) &&
          invalidLine === undefined),
  );

  /** Carry the server across to the other view. JSON that cannot become one form stays put. */
  function switchView(view: ServerDraft["view"]): void {
    if (!draft || view === draft.view) return;
    if (view === "json") {
      const config = configFromDraft(draft, draft.id ?? "");
      const started = config.name !== "" && (config.transport === "stdio" ? config.command : config.url);
      patchDraft({ view, json: started ? serializeMcpJson([config]) : "" });
      return;
    }
    if (!draft.json.trim()) {
      patchDraft({ view });
      return;
    }
    const { servers: found, errors } = parseMcpJson(draft.json);
    if (errors.length > 0) return;
    if (found.length !== 1) {
      toast.error(t("mcp.jsonMulti"));
      return;
    }
    setDraft({ ...draftFromServer(found[0]), id: draft.id });
  }

  async function submit(): Promise<void> {
    if (!draft || !valid) return;
    let next: McpServerConfig[];
    if (draft.view === "json") {
      const { servers: incoming } = parseMcpJson(draft.json);
      // Editing replaces the one server, whatever it is now called; adding merges by name.
      next = draft.id
        ? servers.map((item) => (item.id === draft.id ? { ...incoming[0], id: draft.id } : item))
        : mergeServers(servers, incoming, newServerId);
    } else {
      // A stored server keeps its id: it is what the engine names the server's tools by.
      const config = configFromDraft(draft, draft.id ?? newServerId(draft.name.trim()));
      next = draft.id ? servers.map((item) => (item.id === draft.id ? config : item)) : [...servers, config];
    }
    if (await save(next)) setDraft(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{t("mcp.configured")}</span>
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
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
              onEdit={() => setDraft(draftFromServer(server))}
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

      <AddServerDialog
        draft={draft}
        saving={saving}
        valid={valid}
        invalidLine={invalidLine}
        jsonMessages={jsonMessages}
        onView={switchView}
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
  onEdit,
  onRemove,
}: {
  server: McpServerStatus;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
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
        <IconButton label={t("mcp.edit")} size="icon-xs" variant="ghost" onClick={onEdit}>
          <HugeiconsIcon strokeWidth={2} icon={Edit02Icon} />
        </IconButton>
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

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": { "API_KEY": "…" }
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}`;

function AddServerDialog({
  draft,
  saving,
  valid,
  invalidLine,
  jsonMessages,
  onView,
  onPatch,
  onClose,
  onSubmit,
}: {
  draft: ServerDraft | null;
  saving: boolean;
  valid: boolean;
  invalidLine: string | undefined;
  jsonMessages: string[];
  onView: (view: ServerDraft["view"]) => void;
  onPatch: (next: Partial<ServerDraft>) => void;
  onClose: () => void;
  onSubmit: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{draft?.id ? t("mcp.editTitle") : t("mcp.dialogTitle")}</DialogTitle>
          <DialogDescription>{draft?.view === "json" ? t("mcp.jsonHint") : t("mcp.dialogDesc")}</DialogDescription>
        </DialogHeader>

        {draft ? (
          <Tabs value={draft.view} onValueChange={(view) => onView(view as ServerDraft["view"])} className="gap-3">
            <TabsList className="w-full">
              <TabsTrigger value="form">{t("mcp.viewForm")}</TabsTrigger>
              <TabsTrigger value="json">JSON</TabsTrigger>
            </TabsList>

            <TabsContent value="form" className="space-y-3">
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
                  <MapField
                    label={t("mcp.env")}
                    hint={t("mcp.envHint")}
                    value={draft.env}
                    placeholder={"API_KEY=sk-…\nDEBUG=1"}
                    invalidLine={invalidLine}
                    onChange={(env) => onPatch({ env })}
                  />
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label>URL</Label>
                    <Input
                      value={draft.url}
                      placeholder="https://example.com/mcp"
                      onChange={(event) => onPatch({ url: event.target.value })}
                    />
                  </div>
                  <MapField
                    label={t("mcp.headers")}
                    hint={t("mcp.headersHint")}
                    value={draft.headers}
                    placeholder={"Authorization: Bearer …"}
                    invalidLine={invalidLine}
                    onChange={(headers) => onPatch({ headers })}
                  />
                </>
              )}

              <div className="space-y-1.5">
                <Label>{t("mcp.exposure")}</Label>
                <select
                  value={draft.exposure}
                  onChange={(event) => onPatch({ exposure: event.target.value as McpExposure })}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="direct">{t("mcp.exposureDirect")}</option>
                  <option value="deferred">{t("mcp.exposureDeferred")}</option>
                  <option value="codemode">{t("mcp.exposureCodemode")}</option>
                </select>
                <p className="text-xs text-muted-foreground">{t(`mcp.exposureHint.${draft.exposure}`)}</p>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <Switch checked={draft.enabled} onCheckedChange={(checked) => onPatch({ enabled: checked })} />
                {draft.id ? t("mcp.enabled") : t("mcp.enableAfter")}
              </div>
            </TabsContent>

            <TabsContent value="json" className="space-y-1.5">
              <Textarea
                autoFocus
                value={draft.json}
                rows={12}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-invalid={jsonMessages.length > 0}
                placeholder={JSON_PLACEHOLDER}
                className="max-h-80 overflow-y-auto font-mono text-xs"
                onChange={(event) => onPatch({ json: event.target.value })}
              />
              {jsonMessages.map((message) => (
                <p key={message} className="break-all text-xs text-destructive">
                  {message}
                </p>
              ))}
            </TabsContent>
          </Tabs>
        ) : null}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("mcp.cancel")}
          </Button>
          <Button disabled={!valid || saving} onClick={onSubmit}>
            {saving ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
            {draft?.id ? t("mcp.saveConnect") : t("mcp.addConnect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A `KEY=value` / `Name: value` editor. These values are tokens and paths, so the browser's
 * spelling and capitalisation helpers are switched off — a phone keyboard would otherwise
 * "correct" a secret into something else.
 */
function MapField({
  label,
  hint,
  value,
  placeholder,
  invalidLine,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  invalidLine: string | undefined;
  onChange: (value: string) => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Textarea
        value={value}
        rows={3}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={invalidLine !== undefined}
        placeholder={placeholder}
        className="font-mono"
        onChange={(event) => onChange(event.target.value)}
      />
      {invalidLine !== undefined ? (
        <p className="break-all text-xs text-destructive">{t("mcp.invalidLine", { line: invalidLine })}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
