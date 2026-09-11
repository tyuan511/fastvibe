import { useEffect, useState, type JSX } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ModelPicker } from "@/components/settings/model-picker";
import type { ProviderModel } from "@shared/types";

const PREFERRED = ["grok-4.6", "kimi-k3", "glm-5.3", "glm-5.3-flash", "deepseek-flash", "deepseek-v4-pro"];

export function ConnectForm({ onConnected }: { onConnected: () => void }): JSX.Element {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [candidates, setCandidates] = useState<ProviderModel[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.fastvibe.providers
      .list()
      .then((providers) => {
        const fastvibe = providers.find((provider) => provider.kind === "builtin");
        if (fastvibe) setBaseUrl(fastvibe.baseUrl);
      })
      .catch(() => undefined);
  }, []);

  async function handleFetch(): Promise<void> {
    const key = apiKey.trim();
    if (!key || !baseUrl || busy) return;
    setBusy(true);
    setError(null);
    try {
      const models = await window.fastvibe.providers.fetch(baseUrl, key);
      setCandidates(models);
      const preferred = models.filter((model) => PREFERRED.includes(model.id)).map((model) => model.id);
      setSelected(new Set(preferred.length > 0 ? preferred : models.slice(0, 1).map((model) => model.id)));
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (!candidates || selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.fastvibe.providers.saveFastVibe(
        apiKey.trim(),
        candidates.filter((model) => selected.has(model.id)),
      );
      onConnected();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className={candidates ? "w-full max-w-2xl" : "w-full max-w-md"}>
        <CardHeader>
          <CardTitle>{candidates ? "选择要添加的模型" : "连接 FastVibe"}</CardTitle>
          <CardDescription>
            {candidates
              ? `已拉取 ${candidates.length} 个模型，勾选后加入。`
              : "输入 API 密钥后拉取模型列表，再手动选择。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {candidates ? (
            <ModelPicker models={candidates} selected={selected} onSelectedChange={setSelected} />
          ) : (
            <Input
              type="password"
              autoFocus
              autoComplete="off"
              placeholder="API 密钥"
              value={apiKey}
              disabled={busy}
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleFetch();
              }}
            />
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
        <CardFooter className="gap-2">
          {candidates ? (
            <>
              <Button variant="outline" onClick={() => setCandidates(null)} disabled={busy}>
                <ArrowLeft />
                返回
              </Button>
              <Button className="flex-1" onClick={() => void handleSave()} disabled={busy || selected.size === 0}>
                {busy ? <Spinner /> : null}
                添加 {selected.size} 个模型并连接
              </Button>
            </>
          ) : (
            <Button className="w-full" onClick={() => void handleFetch()} disabled={busy || !apiKey.trim()}>
              {busy ? <Spinner /> : null}
              {busy ? "正在拉取…" : "拉取模型列表"}
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}

function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "操作失败，请重试";
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "");
}
