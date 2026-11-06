import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon, Flowchart01Icon, SourceCodeIcon, ViewIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { ImagePreview } from "@/components/image-preview";
import { useThemeId } from "@/lib/use-theme";
import { isThemeId, THEMES } from "@/lib/themes";
import { MAX_MERMAID_CHARS } from "@/lib/mermaid-source";

export const MermaidBlock = memo(function MermaidBlock({ code, complete }: { code: string; complete: boolean }) {
  const { t } = useTranslation("chat");
  const themeId = useThemeId();
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [result, setResult] = useState<{ code: string; theme: string; url: string | null }>();
  const oversized = code.length > MAX_MERMAID_CHARS;
  const current = result?.code === code && result.theme === themeId ? result : undefined;
  const diagram = !source && current?.url;

  useEffect(() => {
    if (!complete || oversized || source) return;
    let cancelled = false;
    // Closed fences only: token-by-token source never invokes Mermaid's parser/layout.
    void import("@/lib/mermaid-renderer").then(async ({ renderMermaid }) => {
      const theme = THEMES[isThemeId(themeId) ? themeId : "github-light"];
      const url = await renderMermaid(code, theme, () => cancelled);
      if (!cancelled) setResult({ code, theme: themeId, url });
    }).catch(() => {
      if (!cancelled) setResult({ code, theme: themeId, url: null });
    });
    return () => { cancelled = true; };
  }, [code, complete, oversized, source, themeId]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch { /* Clipboard can be unavailable in a preview. */ }
  }

  return (
    <div className={`my-3 min-w-0 overflow-hidden rounded-xl border border-border/70 ${diagram ? "bg-card/50" : "bg-muted/40"}`} data-mermaid-state={diagram ? "diagram" : "source"}>
      <div className={`flex items-center justify-between gap-2 px-3 py-2 ${diagram ? "" : "border-b border-border/70"}`}>
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <HugeiconsIcon strokeWidth={1.75} icon={Flowchart01Icon} className="size-3.5" />
          Mermaid
        </span>
        <div className="flex items-center gap-1">
          {current?.url ? (
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setSource((value) => !value)}>
              <HugeiconsIcon strokeWidth={1.75} icon={source ? ViewIcon : SourceCodeIcon} />
              {t(source ? "mermaid.diagram" : "mermaid.source")}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => void copy()}>
            <HugeiconsIcon strokeWidth={2} icon={copied ? Tick02Icon : Copy01Icon} />
            {t(copied ? "message.copied" : "message.copy")}
          </Button>
        </div>
      </div>
      {diagram ? (
        <div className="overflow-x-auto px-4 pb-5 pt-2 sm:px-6 sm:pb-6">
          <button
            type="button"
            className="mx-auto block max-w-full cursor-zoom-in rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-haspopup="dialog"
            aria-label={t("mermaid.openPreview")}
            onClick={() => setPreviewOpen(true)}
          >
            <img src={diagram} alt={t("mermaid.alt")} className="mx-auto block h-auto max-w-full" />
          </button>
          <ImagePreview
            src={diagram}
            alt={t("mermaid.alt")}
            open={previewOpen}
            onOpenChange={setPreviewOpen}
          />
        </div>
      ) : (
        <>
          {complete && (current?.url === null || oversized) ? (
            <p className="px-3 pt-2 text-xs text-muted-foreground">{t(oversized ? "mermaid.tooLarge" : "mermaid.invalid")}</p>
          ) : null}
          <div className="code-shiki overflow-x-auto px-3 py-2 text-sm leading-5">
            <pre className="font-mono">{oversized && !expanded ? `${code.slice(0, MAX_MERMAID_CHARS)}\n…` : code}</pre>
          </div>
          {oversized ? (
            <div className="border-t border-border px-2 py-1">
              <Button size="xs" variant="ghost" onClick={() => setExpanded((value) => !value)}>
                {t(expanded ? "message.collapseCode" : "message.expandCode", { count: code.length - MAX_MERMAID_CHARS })}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
});
