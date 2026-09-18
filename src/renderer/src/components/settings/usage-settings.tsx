import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { providerLabel } from "@/lib/provider-label";
import { cn } from "@/lib/utils";
import type { UsageDay, UsageModelBreakdown, UsageRange, UsageStats } from "@shared/types";
import { CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";

const RANGE_KEYS: UsageRange[] = ["7d", "30d", "90d", "365d", "all"];
const RANGE_LABEL_KEYS: Record<UsageRange, string> = {
  "7d": "usage.range7d",
  "30d": "usage.range30d",
  "90d": "usage.range90d",
  "365d": "usage.range365d",
  all: "usage.rangeAll",
};
const HEAT_LEVELS = ["bg-muted/60", "bg-primary/15", "bg-primary/30", "bg-primary/60", "bg-primary"];
const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
type ActivityView = "daily" | "weekly" | "cumulative";
type TrendRange = "7d" | "30d";

export function UsageSettings(): JSX.Element {
  const { t, i18n } = useTranslation("settings");
  const [range, setRange] = useState<UsageRange>("365d");
  const [activityView, setActivityView] = useState<ActivityView>("daily");
  const [trendRange, setTrendRange] = useState<TrendRange>("7d");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStats(null);
    setFailed(false);
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
  const peakTokens = stats ? Math.max(0, ...stats.days.map((day) => day.tokens)) : 0;
  const rangeItems = Object.fromEntries(RANGE_KEYS.map((key) => [key, t(RANGE_LABEL_KEYS[key])])) as Record<UsageRange, string>;

  return (
    <div className="space-y-6 pb-8">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-medium tracking-tight">{t("usage.title")}</h2>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">{t("usage.appUsage")}</span>
      </header>

      <section className="grid grid-cols-2 overflow-hidden rounded-xl bg-muted/45 sm:grid-cols-5">
        <SummaryItem label={t("usage.totalTokenCount")} value={totals ? formatCompact(totals.tokens, i18n.language) : "—"} />
        <SummaryItem label={t("usage.peakTokens")} value={stats ? formatCompact(peakTokens, i18n.language) : "—"} />
        <SummaryItem
          label={t("usage.longestChat")}
          value={stats ? formatDuration(stats.longestSessionMinutes ?? 0, t) : "—"}
        />
        <SummaryItem label={t("usage.currentStreak")} value={stats ? t("usage.daysCount", { count: stats.currentStreak ?? 0 }) : "—"} />
        <SummaryItem label={t("usage.longestStreak")} value={stats ? t("usage.daysCount", { count: stats.longestStreak ?? 0 }) : "—"} />
      </section>

      <section className="rounded-xl bg-muted/35 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2.5">
          <h3 className="text-sm font-medium">{t("usage.tokenActivity")}</h3>
          <div className="flex items-center gap-2">
            <Select items={rangeItems} value={range} onValueChange={(value) => setRange(value as UsageRange)}>
              <SelectTrigger size="sm" className="w-28 bg-background/70">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>{rangeItems[key]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Tabs value={activityView} onValueChange={(value) => setActivityView(value as ActivityView)}>
              <TabsList>
                <TabsTrigger value="daily" className="px-3">{t("usage.daily")}</TabsTrigger>
                <TabsTrigger value="weekly" className="px-3">{t("usage.weekly")}</TabsTrigger>
                <TabsTrigger value="cumulative" className="px-3">{t("usage.cumulative")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
        {failed ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t("usage.loadFailed")}</p>
        ) : stats ? (
          <Heatmap stats={stats} view={activityView} dimmed={loading} />
        ) : (
          <div className="h-48 animate-pulse rounded-xl bg-muted/50" />
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2.5 px-1">
          <h3 className="text-sm font-medium">{t("usage.dailyTokenTrend")}</h3>
          <Tabs value={trendRange} onValueChange={(value) => setTrendRange(value as TrendRange)}>
            <TabsList>
              <TabsTrigger value="7d" className="px-3">{t("usage.range7Short")}</TabsTrigger>
              <TabsTrigger value="30d" className="px-3">{t("usage.range30Short")}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="rounded-xl bg-muted/35 p-4">
          {stats ? <TrendChart stats={stats} range={trendRange} /> : <div className="h-64 animate-pulse rounded-xl bg-muted/50" />}
        </div>
      </section>

      {stats ? <ModelUsage stats={stats} language={i18n.language} /> : null}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0 px-3 py-4 text-center sm:px-3 sm:first:pl-4 sm:last:pr-4 sm:[&+div]:border-l sm:[&+div]:border-border/70">
      <p className="truncate text-xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1.5 truncate text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Heatmap({ stats, view, dimmed }: { stats: UsageStats; view: ActivityView; dimmed: boolean }): JSX.Element {
  const { t } = useTranslation("settings");
  const weekdays = t("usage.weekdays", { returnObjects: true }) as string[];
  const dayMap = useMemo(() => new Map(stats.days.map((day) => [day.date, day])), [stats.days]);
  const { weeks, months } = useMemo(
    () => buildCalendar(stats.from, stats.to, (month) => t("usage.month", { n: month + 1 })),
    [stats.from, stats.to, t],
  );
  const weekTotals = useMemo(
    () => weeks.map((week) => week.reduce((sum, cell) => sum + (cell.inRange ? dayMap.get(cell.key)?.tokens ?? 0 : 0), 0)),
    [weeks, dayMap],
  );
  const gridRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState({ column: 0, gap: 0, label: 0 });

  useLayoutEffect(() => {
    const node = gridRef.current;
    const ruler = rulerRef.current;
    if (!node || !ruler) return undefined;
    const measure = (): void => {
      const styles = getComputedStyle(node);
      const tracks = styles.gridTemplateColumns.split(" ").map(Number.parseFloat).filter(Number.isFinite);
      const column = tracks.length > 1 ? tracks[1] : 0;
      const gap = Number.parseFloat(styles.columnGap) || 0;
      const label = ruler.getBoundingClientRect().width;
      setFit((current) => current.column === column && current.gap === gap && current.label === label ? current : { column, gap, label });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [weeks.length]);

  const values = useMemo(() => {
    let cumulative = 0;
    return weeks.map((week, weekIndex) => week.map((cell) => {
      const value = cell.inRange ? dayMap.get(cell.key)?.tokens ?? 0 : 0;
      if (view === "weekly") return weekTotals[weekIndex];
      if (view === "cumulative") {
        cumulative += value;
        return cumulative;
      }
      return value;
    }));
  }, [dayMap, view, weekTotals, weeks]);
  const thresholds = useMemo(() => {
    const flat = values.flat().filter((value) => value > 0).sort((a, b) => a - b);
    const at = (ratio: number): number => flat.length ? flat[Math.min(flat.length - 1, Math.floor(flat.length * ratio))] : 0;
    return [at(0.25), at(0.5), at(0.75)];
  }, [values]);
  const level = (value: number): number => value <= 0 ? 0 : value <= thresholds[0] ? 1 : value <= thresholds[1] ? 2 : value <= thresholds[2] ? 3 : 4;
  const captionFits = (cols: number): boolean => cols * (fit.column + fit.gap) - fit.gap >= fit.label;

  return (
    <div className={cn("transition-opacity", dimmed && "opacity-50")}>
      <div
        ref={gridRef}
        className="grid"
        style={{ gridTemplateColumns: `auto repeat(${weeks.length}, minmax(0, 1fr))`, columnGap: "0.125rem", rowGap: "0.125rem", maxWidth: `${weeks.length * 0.875}rem` }}
      >
        <div />
        <span ref={rulerRef} aria-hidden className="invisible absolute text-xs whitespace-nowrap">{t("usage.monthRuler")}</span>
        {months.map((month, index) => (
          <div key={index} className="min-w-0 overflow-hidden self-end text-xs whitespace-nowrap text-muted-foreground" style={{ gridColumn: `span ${Math.max(1, month.cols)}` }}>
            {captionFits(month.cols) ? month.label : ""}
          </div>
        ))}
        {weekdays.map((label, dayIndex) => (
          <Fragment key={label || dayIndex}>
            <div className="w-3 pr-0.5 text-right text-xs leading-none text-muted-foreground">{label}</div>
            {weeks.map((week, weekIndex) => {
              const cell = week[dayIndex];
              const day = cell?.inRange ? dayMap.get(cell.key) : undefined;
              const value = values[weekIndex][dayIndex];
              if (!cell || !cell.inRange) return <div key={weekIndex} aria-hidden className="aspect-square w-full" />;
              return (
                <Tooltip key={weekIndex}>
                  <TooltipTrigger render={<div className={cn("aspect-square w-full rounded-[3px] transition-shadow", HEAT_LEVELS[level(value)], "hover:ring-1 hover:ring-foreground/25")} aria-label={cell.key} />} />
                  <TooltipContent side="top"><DayTooltip date={cell.key} day={day} value={value} /></TooltipContent>
                </Tooltip>
              );
            })}
          </Fragment>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
        <span>{stats.from.slice(5).replace("-", "/")}</span>
        <span>{stats.to.slice(5).replace("-", "/")}</span>
      </div>
    </div>
  );
}

function TrendChart({ stats, range }: { stats: UsageStats; range: TrendRange }): JSX.Element {
  const { t, i18n } = useTranslation("settings");
  const dates = useMemo(() => buildTrendDates(stats, range), [stats, range]);
  const models = stats.models.slice(0, 5);
  const series = models.length ? models : [{ provider: "", model: t("usage.totalTokens"), tokens: stats.totals.tokens } as UsageModelBreakdown];
  const data = useMemo(
    () => dates.map((date) => ({
      date,
      ...Object.fromEntries(series.map((model, index) => [`series${index}`, valueForModel(model, date, stats)])),
    })),
    [dates, series, stats],
  );
  const config = useMemo(
    () => Object.fromEntries(series.map((model, index) => [`series${index}`, { label: model.model, color: CHART_COLORS[index % CHART_COLORS.length] }])) as ChartConfig,
    [series],
  );
  const labelEvery = dates.length > 14 ? 5 : 1;

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
        {series.map((model, index) => (
          <div key={`${model.provider}/${model.model}`} className="flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }} />
            <span className="max-w-48 truncate">{model.model}</span>
          </div>
        ))}
      </div>
      <ChartContainer config={config} className="h-64 w-full aspect-auto" aria-label={t("usage.dailyTokenTrend")}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" opacity={0.55} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            interval={labelEvery - 1}
            tickFormatter={(value) => formatDateLabel(String(value), i18n.language)}
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
          />
          <YAxis hide domain={[0, "auto"]} />
          <ChartTooltip
            cursor={{ stroke: "var(--border)" }}
            content={
              <ChartTooltipContent
                labelFormatter={(value) => formatDateLabel(String(value), i18n.language)}
                formatter={(value, name) => {
                  const modelName = config[String(name)]?.label ?? name;
                  return `${modelName}：${formatCompact(Number(value), i18n.language)}`;
                }}
              />
            }
          />
          {series.map((model, index) => (
            <Line
              key={`${model.provider}/${model.model}`}
              type="monotone"
              dataKey={`series${index}`}
              stroke={`var(--color-series${index})`}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  );
}

function ModelUsage({ stats, language }: { stats: UsageStats; language: string }): JSX.Element {
  const { t } = useTranslation("settings");
  const modelTotal = stats.models.reduce((sum, model) => sum + model.tokens, 0);
  const remainder = Math.max(0, stats.totals.tokens - modelTotal);
  const items = [
    ...stats.models.slice(0, 5).map((model) => ({
      id: `${model.provider}/${model.model}`,
      label: model.model,
      provider: model.providerName?.trim() || providerLabel(model.provider),
      tokens: model.tokens,
    })),
    ...(remainder > 0 ? [{ id: "other", label: t("usage.other"), provider: "", tokens: remainder }] : []),
  ];
  const total = Math.max(1, items.reduce((sum, item) => sum + item.tokens, 0));
  const pieConfig = { tokens: { label: t("usage.tokens"), color: CHART_COLORS[0] } } satisfies ChartConfig;

  return (
    <section className="rounded-xl bg-muted/35 p-4">
      <h3 className="mb-4 text-sm font-medium">{t("usage.modelUsage")}</h3>
      <div className="flex flex-col items-center gap-6 md:flex-row md:gap-8">
        <div className="relative size-64 shrink-0">
          <ChartContainer config={pieConfig} className="size-full aspect-square">
            <PieChart>
              <Pie data={items} dataKey="tokens" nameKey="label" innerRadius="58%" outerRadius="82%" paddingAngle={1} stroke="none">
                {items.map((item, index) => <Cell key={item.id} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
              </Pie>
            </PieChart>
          </ChartContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <strong className="text-xl tabular-nums">{formatCompact(stats.totals.tokens, language)}</strong>
            <span className="text-xs text-muted-foreground">{t("usage.tokens")}</span>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          {items.map((item, index) => (
            <div key={item.id} className="flex items-center gap-3 text-sm">
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }} />
              <span className="min-w-0 flex-1 truncate">
                <span className="block truncate">{item.label}</span>
                {item.provider ? <span className="block truncate text-xs text-muted-foreground">{item.provider}</span> : null}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">{formatCompact(item.tokens, language)} {t("usage.tokens")}</span>
              <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">{Math.round((item.tokens / total) * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function valueForModel(model: UsageModelBreakdown, date: string, stats: UsageStats): number {
  if (model.days) return model.days.find((day) => day.date === date)?.tokens ?? 0;
  const total = model.tokens || 0;
  return stats.totals.tokens > 0 ? (total / stats.totals.tokens) * (stats.days.find((day) => day.date === date)?.tokens ?? 0) : 0;
}

function buildTrendDates(stats: UsageStats, range: TrendRange): string[] {
  const end = parseDateKey(stats.to);
  const start = new Date(end);
  start.setDate(start.getDate() - (range === "7d" ? 6 : 29));
  if (stats.from > dateKey(start)) {
    const bounded = parseDateKey(stats.from);
    start.setTime(bounded.getTime());
  }
  const dates: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) dates.push(dateKey(cursor));
  return dates.length ? dates : [stats.to];
}

function DayTooltip({ date, day, value }: { date: string; day?: UsageDay; value?: number }): JSX.Element {
  const { t, i18n } = useTranslation("settings");
  const tokens = value ?? day?.tokens ?? 0;
  return (
    <div className="space-y-0.5">
      <p className="font-medium">{formatDateLabel(date, i18n.language)}</p>
      <p>{tokens > 0 ? `${formatCompact(tokens, i18n.language)} ${t("usage.tokens")}` : t("usage.noActivity")}</p>
    </div>
  );
}

type CalendarCell = { key: string; inRange: boolean };
type CalendarMonth = { label: string; cols: number };

function buildCalendar(from: string, to: string, monthLabel: (month: number) => string): { weeks: CalendarCell[][]; months: CalendarMonth[] } {
  const start = parseDateKey(from);
  const startDay = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - startDay);
  const end = parseDateKey(to);
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
      months.push({ label: monthLabel(month), cols: 1 });
      previous = month;
    } else months[months.length - 1].cols += 1;
  }
  return { weeks, months };
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDateLabel(value: string, language: string | undefined): string {
  const [, month, day] = value.split("-").map(Number);
  return language?.startsWith("zh") ? `${month}月${day}日` : `${month}/${day}`;
}

function formatCompact(value: number, language: string): string {
  if (language.startsWith("zh")) {
    if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
    if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 1_000_000 ? 0 : 1)} 万`;
  }
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return Math.round(value).toLocaleString(language.startsWith("zh") ? "zh-CN" : "en-US");
}

function formatDuration(minutes: number, t: TFunction): string {
  if (minutes <= 0) return "—";
  return t("usage.minutes", { count: Math.max(1, Math.round(minutes)) });
}