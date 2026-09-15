import { Fragment, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { providerLabel } from "@/lib/provider-label";
import { cn } from "@/lib/utils";
import type { UsageDay, UsageRange, UsageStats } from "@shared/types";

const RANGE_ITEMS: Record<UsageRange, string> = {
  "7d": "最近 7 天",
  "30d": "最近 30 天",
  "90d": "最近 90 天",
  "365d": "最近一年",
  all: "全部时间",
};

type HeatMetric = "requests" | "tokens";
const METRIC_ITEMS: Record<HeatMetric, string> = {
  requests: "按请求数",
  tokens: "按 Token",
};

/** GitHub-style intensity ramp; level 0 is an empty day. */
const LEVEL_CLASSES = [
  "bg-muted",
  "bg-emerald-500/25 dark:bg-emerald-400/25",
  "bg-emerald-500/45 dark:bg-emerald-400/45",
  "bg-emerald-500/70 dark:bg-emerald-400/65",
  "bg-emerald-600 dark:bg-emerald-400/90",
];

/*
 * Grid geometry, in rem so the heat map tracks the 界面字号 scale. The cell is one
 * `text-xs` line (0.75rem) tall/wide so the caption and gutter labels fit it.
 */
const CELL = 0.75;
const GAP = 0.125;
const WEEKDAYS = ["一", "", "三", "", "五", "", "日"];

export function UsageSettings(): JSX.Element {
  const [range, setRange] = useState<UsageRange>("365d");
  const [metric, setMetric] = useState<HeatMetric>("requests");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.fastvibe.stats
      .usage(range)
      .then((next) => {
        if (cancelled) return;
        setStats(next);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const totals = stats?.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          items={METRIC_ITEMS}
          value={metric}
          onValueChange={(value) => setMetric(value as HeatMetric)}
        >
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="requests">按请求数</SelectItem>
            <SelectItem value="tokens">按 Token</SelectItem>
          </SelectContent>
        </Select>
        <Select
          items={RANGE_ITEMS}
          value={range}
          onValueChange={(value) => setRange(value as UsageRange)}
        >
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(RANGE_ITEMS) as UsageRange[]).map((key) => (
              <SelectItem key={key} value={key}>
                {RANGE_ITEMS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label="总请求"
          value={totals ? formatCount(totals.requests) : "—"}
          hint={totals ? `工具调用 ${formatCount(totals.toolCalls)} 次` : undefined}
        />
        <StatCard
          label="总 Token"
          value={totals ? formatTokens(totals.tokens) : "—"}
          hint={
            totals
              ? `输入 ${formatTokens(totals.input)} · 输出 ${formatTokens(totals.output)}`
              : undefined
          }
        />
        <StatCard
          label="预估花费"
          value={totals ? formatCost(totals.cost) : "—"}
          hint={totals && totals.cacheRead > 0 ? `缓存读取 ${formatTokens(totals.cacheRead)}` : "按供应商返回计费"}
        />
        <StatCard
          label="活跃天数"
          value={totals ? formatCount(totals.activeDays) : "—"}
          hint={stats ? `${stats.from} ~ ${stats.to}` : undefined}
        />
      </div>

      <section className="rounded-xl border border-border bg-card p-4">
        <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">活跃状态</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {stats
                ? `${stats.from} ~ ${stats.to} · ${stats.sessions} 个会话`
                : "按天统计的请求 / Token 活跃度"}
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>少</span>
            {LEVEL_CLASSES.map((tone, index) => (
              <span key={index} className={cn("size-3 rounded-[2px]", tone)} />
            ))}
            <span>多</span>
          </div>
        </header>
        {failed ? (
          <p className="py-6 text-center text-xs text-muted-foreground">无法读取使用统计。</p>
        ) : stats ? (
          <Heatmap stats={stats} metric={metric} dimmed={loading} />
        ) : (
          <div className="h-27.5 animate-pulse rounded-lg bg-muted/40" />
        )}
      </section>

      {stats && stats.models.length > 0 ? (
        <section className="space-y-2">
          <h3 className="px-1 text-sm font-medium">模型用量</h3>
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {stats.models.map((model) => {
              const share = stats.totals.tokens > 0 ? model.tokens / stats.totals.tokens : 0;
              return (
                <div key={`${model.provider}/${model.model}`} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{model.model}</p>
                      <p className="truncate text-xs text-muted-foreground">{providerLabel(model.provider)}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs tabular-nums">{formatTokens(model.tokens)}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {formatCount(model.requests)} 次 · {formatCost(model.cost)}
                      </p>
                    </div>
                  </div>
                  <Progress value={share * 100} className="mt-2.5" />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
}): JSX.Element {
  return (
    <Card size="sm" className="gap-0.5 py-3">
      <div className="px-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl leading-none font-semibold tabular-nums">{value}</p>
        {hint ? <p className="mt-1.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </Card>
  );
}

/** Sparse `stats.days` is filled into a Monday-first calendar; each column is a week. */
function Heatmap({
  stats,
  metric,
  dimmed,
}: {
  stats: UsageStats;
  metric: HeatMetric;
  dimmed: boolean;
}): JSX.Element {
  const dayMap = useMemo(() => {
    const map = new Map<string, UsageDay>();
    for (const day of stats.days) map.set(day.date, day);
    return map;
  }, [stats.days]);

  const { weeks, months } = useMemo(() => buildCalendar(stats.from, stats.to), [stats.from, stats.to]);

  const valueOf = (day: UsageDay | undefined): number =>
    day ? (metric === "requests" ? day.requests : day.tokens) : 0;

  // Quantile thresholds keep a single huge day from flattening the rest.
  const thresholds = useMemo(() => {
    const values = stats.days
      .map((day) => (metric === "requests" ? day.requests : day.tokens))
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
    const at = (q: number): number =>
      values.length ? values[Math.min(values.length - 1, Math.floor(values.length * q))] : 0;
    return [at(0.25), at(0.5), at(0.75)];
  }, [stats.days, metric]);

  const level = (value: number): number => {
    if (value <= 0) return 0;
    if (value <= thresholds[0]) return 1;
    if (value <= thresholds[1]) return 2;
    if (value <= thresholds[2]) return 3;
    return 4;
  };

  // One grid owns every row: the weekday gutter, the month captions and the cells
  // share the same tracks, so a caption can never drift onto the first cell row.
  return (
    <div className={cn("overflow-x-auto pb-1 transition-opacity", dimmed && "opacity-50")}>
      <div
        className="w-fit"
        style={{
          display: "grid",
          gridTemplateColumns: `auto repeat(${weeks.length}, ${CELL}rem)`,
          columnGap: `${GAP}rem`,
          rowGap: `${GAP}rem`,
        }}
      >
        <div />
        {months.map((month, index) => (
          // Every caption still consumes its weeks so the header row keeps the
          // grid aligned; a month owning a single column is left blank instead of
          // clipping the glyph.
          <div
            key={index}
            className="self-end text-xs leading-none whitespace-nowrap text-muted-foreground"
            style={{ gridColumn: `span ${Math.max(1, month.cols)}` }}
          >
            {month.cols >= 2 ? month.label : ""}
          </div>
        ))}
        {WEEKDAYS.map((label, dayIndex) => (
          <Fragment key={label || dayIndex}>
            <div className="w-3 pr-0.5 text-right text-xs leading-none text-muted-foreground">
              {label}
            </div>
            {weeks.map((week, weekIndex) => {
              const cell = week[dayIndex];
              const day = cell?.inRange ? dayMap.get(cell.key) : undefined;
              const value = valueOf(day);
              if (!cell || !cell.inRange) {
                return <div key={weekIndex} className="size-3" />;
              }
              return (
                <Tooltip key={weekIndex}>
                  <TooltipTrigger
                    render={
                      <div
                        className={cn("size-3 rounded-[2px]", LEVEL_CLASSES[level(value)])}
                        aria-label={cell.key}
                      />
                    }
                  />
                  <TooltipContent side="top">
                    <DayTooltip date={cell.key} day={day} />
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function DayTooltip({ date, day }: { date: string; day?: UsageDay }): JSX.Element {
  const requests = day?.requests ?? 0;
  return (
    <div className="space-y-0.5">
      <p className="font-medium">{date}</p>
      <p>{requests > 0 ? `${formatCount(requests)} 次请求` : "没有活动"}</p>
      {day && day.tokens > 0 ? <p>{formatTokens(day.tokens)} Token</p> : null}
      {day && day.cost > 0 ? <p>{formatCost(day.cost)}</p> : null}
    </div>
  );
}

type CalendarCell = { key: string; inRange: boolean };
type CalendarMonth = { label: string; cols: number };

function buildCalendar(from: string, to: string): { weeks: CalendarCell[][]; months: CalendarMonth[] } {
  const start = parseDateKey(from);
  // Monday-first: shift back to the Monday on/before the window start.
  const startDay = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - startDay);
  const end = parseDateKey(to);
  // Pad forward to the Sunday that closes the last column.
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));

  const cells: CalendarCell[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const key = dateKey(cursor);
    cells.push({ key, inRange: key >= from && key <= to });
  }

  const weeks: CalendarCell[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));

  const months: CalendarMonth[] = [];
  let previous = -1;
  for (const week of weeks) {
    const first = week.find((cell) => cell.inRange) ?? week[0];
    const month = parseDateKey(first.key).getMonth();
    if (month !== previous) {
      months.push({ label: `${month + 1}月`, cols: 1 });
      previous = month;
    } else {
      months[months.length - 1].cols += 1;
    }
  }
  return { weeks, months };
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return formatCount(value);
}

function formatCost(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
