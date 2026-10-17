import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { BrowserClearData, BrowserLibrary } from "@shared/browser-workspace";

export function BrowserHistoryDialog({ open, library, error, close, go }: {
  open: boolean;
  library: BrowserLibrary | null;
  error: string | null;
  close: () => void;
  go: (url: string) => void;
}) {
  const { t, i18n } = useTranslation("sidepane");
  const [query, setQuery] = useState("");
  const history = library?.history.filter((item) => `${item.title} ${item.url}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("browser.history")}</DialogTitle>
          <DialogDescription>{t("browser.historyDescription")}</DialogDescription>
        </DialogHeader>
        <Input aria-label={t("browser.searchHistory")} placeholder={t("browser.searchHistory")} value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="min-h-0 overflow-y-auto" aria-live="polite">
          {error ? <p className="py-8 text-center text-sm text-destructive">{error}</p> : !library ? <p className="py-8 text-center text-sm text-muted-foreground">{t("browser.loadingRecords")}</p> : history.length ? history.map((item) => (
            <Button key={item.url} variant="ghost" className="h-auto w-full justify-start gap-3 py-3 text-left" onClick={() => { go(item.url); close(); }}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{item.title || item.url}</span>
                <span className="block truncate text-xs text-muted-foreground">{item.url}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{new Date(item.visitedAt).toLocaleDateString(i18n.language)}</span>
            </Button>
          )) : <p className="py-8 text-center text-sm text-muted-foreground">{t(query ? "browser.historyNoMatch" : "browser.historyEmpty")}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BrowserClearDialog({ open, close, onCleared }: { open: boolean; close: () => void; onCleared: (options: BrowserClearData) => void }) {
  const { t } = useTranslation("sidepane");
  const [chosen, setChosen] = useState<BrowserClearData>({ cache: true });
  const [busy, setBusy] = useState(false);
  async function clear(): Promise<void> {
    setBusy(true);
    try {
      await window.fastvibe.browser.clearData(chosen);
      onCleared(chosen);
      toast.success(t("browser.cleared"));
      close();
    } catch (error) { toast.error(t("browser.clearFailed"), { description: String(error) }); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={(value) => { if (!value && !busy) close(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{t("browser.clearData")}</DialogTitle><DialogDescription>{t("browser.clearDescription")}</DialogDescription></DialogHeader>
      <div className="flex flex-col gap-4 py-2">
        {(["cache", "cookies", "history", "downloads"] as const).map((key) => <label key={key} className="flex cursor-pointer items-center gap-3 text-sm">
          <Checkbox checked={!!chosen[key]} disabled={busy} onCheckedChange={(checked) => setChosen({ ...chosen, [key]: checked })} />
          {t(`browser.clear.${key}`)}
        </label>)}
      </div>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>{t("browser.cancel")}</Button><Button variant="destructive" disabled={busy || !Object.values(chosen).some(Boolean)} onClick={() => void clear()}>{t(busy ? "browser.clearing" : "browser.clearData")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
