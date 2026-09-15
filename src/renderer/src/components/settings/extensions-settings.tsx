import { useEffect, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Delete02Icon,
  Loading03Icon,
  PackageIcon,
  PuzzleIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { IconButton } from "@/components/icon-button";
import type { ExtensionInfo, ExtensionPackage } from "@shared/types";

/**
 * Plugins are pi packages installed into FastVibe's isolated agentDir. Installing
 * one pulls its npm dependencies and registers its extension entry points, which
 * the next session (or an idle reload) picks up as slash commands, tools and UI.
 */
export function ExtensionsSettings(): JSX.Element {
  const [packages, setPackages] = useState<ExtensionPackage[]>([]);
  const [loaded, setLoaded] = useState<ExtensionInfo[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [next, extensions] = await Promise.all([
        window.fastvibe.engine.listExtensionPackages(),
        window.fastvibe.engine.getExtensions(),
      ]);
      setPackages(next);
      setLoaded(extensions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取插件列表");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function install(): Promise<void> {
    const value = source.trim();
    if (!value) return;
    setBusy(true);
    try {
      setPackages(await window.fastvibe.engine.installExtensionPackage(value));
      setSource("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "安装失败，请检查包名与网络");
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: string): Promise<void> {
    setBusy(true);
    try {
      setPackages(await window.fastvibe.engine.removeExtensionPackage(target));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "卸载失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] leading-5 text-muted-foreground">
        插件是 pi 包，安装到 FastVibe 独立的数据目录，不写入你自己的 <code>~/.pi</code>
        。安装后其命令、工具与状态会出现在对话中。
      </p>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium">已安装 {packages.length}</span>
        <IconButton
          label="刷新"
          size="icon-sm"
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
        </IconButton>
      </div>

      {packages.length ? (
        <ItemGroup className="gap-0! overflow-hidden rounded-xl bg-muted">
          {packages.map((item, index) => {
            // The loader reports the extension file path, which lives under the
            // package's own node_modules directory, so match on the path not name.
            const state = loaded.find((entry) => entry.path.includes(packageName(item.source)));
            return (
              <div key={item.source}>
                {index > 0 ? <Separator /> : null}
                <PackageRow
                  item={item}
                  loaded={state && !state.error}
                  error={state?.error}
                  onRemove={() => void remove(item.source)}
                  busy={busy}
                />
              </div>
            );
          })}
        </ItemGroup>
      ) : (
        <Empty className="border border-dashed border-border py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon strokeWidth={2} icon={PuzzleIcon} />
            </EmptyMedia>
            <EmptyTitle>尚未安装插件</EmptyTitle>
            <EmptyDescription>在下方输入 npm 包名安装，例如 npm:pi-web-access</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={source}
          placeholder="npm:pi-web-access 或 git:github.com/user/repo"
          disabled={busy}
          onChange={(event) => setSource(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void install();
            }
          }}
        />
        <Button disabled={busy || !source.trim()} onClick={() => void install()}>
          {busy ? (
            <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" />
          ) : (
            <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
          )}
          安装
        </Button>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function PackageRow({
  item,
  loaded,
  error,
  busy,
  onRemove,
}: {
  item: ExtensionPackage;
  loaded?: boolean;
  error?: string;
  busy: boolean;
  onRemove: () => void;
}): JSX.Element {
  return (
    <Item size="sm" className="rounded-none px-3 py-2.5">
      <ItemMedia className="self-center translate-y-0">
        <span className="flex size-9 items-center justify-center rounded-full bg-background text-muted-foreground">
          <HugeiconsIcon strokeWidth={2} icon={PackageIcon} className="size-4" />
        </span>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex items-center gap-1.5 font-medium">
          <span className="truncate">{packageName(item.source)}</span>
          {item.builtin ? <Badge variant="secondary">内置</Badge> : null}
          {error ? <Badge variant="destructive">加载失败</Badge> : loaded ? <Badge variant="secondary">已加载</Badge> : null}
        </ItemTitle>
        <ItemDescription className="line-clamp-1">{item.source}</ItemDescription>
        {error ? <ItemDescription className="line-clamp-2 text-destructive">{error}</ItemDescription> : null}
      </ItemContent>
      <ItemActions>
        <IconButton
          label="卸载插件"
          size="icon-xs"
          variant="ghost"
          disabled={busy}
          onClick={onRemove}
        >
          <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
        </IconButton>
      </ItemActions>
    </Item>
  );
}

/** `npm:@scope/name@1.0` → `@scope/name`; `npm:name` → `name`. */
function packageName(source: string): string {
  const withoutScheme = source.replace(/^(npm|git):/, "");
  const withoutVersion = withoutScheme.replace(/@[\d^~>=][^/]*$/, "");
  return withoutVersion.split("/").slice(-2).join("/");
}
