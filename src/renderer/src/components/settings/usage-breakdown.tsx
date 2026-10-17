import { useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSessionStore } from "@/stores/session";
import type { UsageStats } from "@shared/types";

export function UsageBreakdown({ stats }: { stats: UsageStats }): JSX.Element {
  const { t, i18n } = useTranslation("settings");
  const [groupBy, setGroupBy] = useState<"project" | "conversation">("project");
  const projects = useSessionStore((state) => state.projects);
  const groups = useMemo(() => {
    const result = new Map<string, { id: string; label: string; cost: number; tokens: number }>();
    for (const usage of stats.conversations ?? []) {
      const id = groupBy === "conversation" ? usage.sessionId : usage.project ?? (usage.conversationId ? "scratch" : "deleted");
      const label = groupBy === "conversation" ? usage.title || t("usage.unavailableChat") : usage.project ? projects.find((item) => item.cwd === usage.project)?.name ?? usage.project : t(usage.conversationId ? "usage.scratch" : "usage.unavailableChat");
      const group = result.get(id) ?? { id, label, cost: 0, tokens: 0 };
      group.cost += usage.cost;
      group.tokens += usage.tokens;
      result.set(id, group);
    }
    return [...result.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  }, [stats, groupBy, projects, t]);
  const tokens = (value: number): string => new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const usd = (value: number): string => new Intl.NumberFormat(i18n.language, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value);
  const totals = stats.totals;
  return <section className="space-y-3">
    <div className="rounded-xl bg-muted/35 p-4">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[[t("usage.estimatedCost"), usd(totals.cost)], [t("usage.inputTokens"), tokens(totals.input)], [t("usage.outputTokens"), tokens(totals.output)], [t("usage.cacheTokens"), tokens(totals.cacheRead + totals.cacheWrite)]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-medium tabular-nums">{value}</dd></div>)}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">{t("usage.estimateHint")}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t("usage.cacheDetail", { read: tokens(totals.cacheRead), write: tokens(totals.cacheWrite), rate: Math.round(100 * totals.cacheRead / Math.max(1, totals.input + totals.cacheRead + totals.cacheWrite)) })}</p>
    </div>
    {groups.length ? <>
      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{t("usage.costBreakdown")}</h3><Tabs value={groupBy} onValueChange={(value) => setGroupBy(value as "project" | "conversation")}><TabsList><TabsTrigger value="project">{t("usage.byProject")}</TabsTrigger><TabsTrigger value="conversation">{t("usage.byConversation")}</TabsTrigger></TabsList></Tabs></div>
      <div className="max-h-72 overflow-auto rounded-lg border border-border"><table className="w-full text-sm"><thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="p-3">{t(groupBy === "project" ? "usage.byProject" : "usage.byConversation")}</th><th className="p-3 text-right">Token</th><th className="p-3 text-right">{t("usage.estimatedCost")}</th></tr></thead><tbody>{groups.map((item) => <tr key={item.id} className="border-b last:border-0"><td className="max-w-72 truncate p-3" title={item.label}>{item.label}</td><td className="p-3 text-right tabular-nums">{tokens(item.tokens)}</td><td className="p-3 text-right tabular-nums">{usd(item.cost)}</td></tr>)}</tbody></table></div>
    </> : null}
  </section>;
}
