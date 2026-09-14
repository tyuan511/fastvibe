import { useEffect, useState, type JSX } from "react";
import { CheckCircle2, CircleAlert, Plug, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { McpServerConfig, McpServerStatus } from "@shared/types";

export function McpSettings(): JSX.Element {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<McpServerConfig["transport"]>("stdio");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  async function refresh(): Promise<void> {
    try { setServers(await window.fastvibe.omp.listMcpServers()); } catch { setServers([]); }
  }
  useEffect(() => { void refresh(); }, []);

  async function save(next: McpServerConfig[]): Promise<void> {
    setSaving(true);
    try { setServers(await window.fastvibe.omp.saveMcpServers(next)); } finally { setSaving(false); }
  }

  function add(): void {
    const trimmed = name.trim();
    if (!trimmed || (transport === "stdio" ? !command.trim() : !url.trim())) return;
    const id = `${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
    const config: McpServerConfig = { id, name: trimmed, enabled, transport, ...(transport === "stdio" ? { command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : undefined } : { url: url.trim() }) };
    void save([...servers, { ...config, connected: false, tools: [] }]);
    setName(""); setCommand(""); setArgs(""); setUrl("");
  }

  return <div className="space-y-5">
    <div className="space-y-2"><h3 className="text-[13px] font-semibold">MCP 服务器</h3><p className="text-xs leading-5 text-muted-foreground">连接到 MCP 工具服务器。启用后，工具会注册到当前会话并经过现有权限策略。</p></div>
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      {servers.length ? servers.map((server) => <div key={server.id} className="flex items-center gap-3 rounded-lg border border-border/70 px-3 py-2.5"><Plug className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{server.name}</p><p className="truncate text-[11px] text-muted-foreground">{server.transport === "stdio" ? `${server.command ?? ""} ${(server.args ?? []).join(" ")}` : server.url}</p></div>{server.connected ? <Badge variant="secondary"><CheckCircle2 className="size-3" />{server.tools.length} 个工具</Badge> : <Badge variant="outline"><CircleAlert className="size-3" />未连接</Badge>}<Switch checked={server.enabled} onCheckedChange={(checked) => void save(servers.map((item) => item.id === server.id ? { ...item, enabled: checked } : item))} /><Button size="icon-xs" variant="ghost" onClick={() => void save(servers.filter((item) => item.id !== server.id))}><Trash2 /></Button></div>) : <p className="py-3 text-center text-xs text-muted-foreground">尚未配置 MCP 服务器</p>}
    </div>
    <div className="space-y-3 rounded-xl border border-border bg-card p-4"><h3 className="text-[13px] font-semibold">添加服务器</h3><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>名称</Label><Input value={name} placeholder="例如 filesystem" onChange={(event) => setName(event.target.value)} /></div><div className="space-y-1.5"><Label>传输</Label><select value={transport} onChange={(event) => setTransport(event.target.value as McpServerConfig["transport"])} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="stdio">本地进程（stdio）</option><option value="http">HTTP（Streamable HTTP）</option></select></div></div>{transport === "stdio" ? <><div className="space-y-1.5"><Label>命令</Label><Input value={command} placeholder="npx -y @modelcontextprotocol/server-filesystem" onChange={(event) => setCommand(event.target.value)} /></div><div className="space-y-1.5"><Label>参数（空格分隔）</Label><Input value={args} placeholder="/Users/me/project" onChange={(event) => setArgs(event.target.value)} /></div></> : <div className="space-y-1.5"><Label>URL</Label><Input value={url} placeholder="https://example.com/mcp" onChange={(event) => setUrl(event.target.value)} /></div>}<div className="flex items-center justify-between"><div className="flex items-center gap-2 text-xs"><Switch checked={enabled} onCheckedChange={setEnabled} />添加后启用</div><Button size="sm" disabled={saving || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())} onClick={add}><Plus className="size-3.5" />添加并连接</Button></div></div>
  </div>;
}
