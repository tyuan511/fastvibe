//! Shared usage query, local presentation. Every async result belongs to one settings instance.
use std::collections::BTreeMap;

use chrono::{Datelike, Days, NaiveDate};
use fv_protocol::methods::StatsUsage;
use fv_protocol::types::UiLanguage;
use fv_protocol::usage::*;
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::settings::{Section, card, outline_button};
use crate::theme::Palette;
use crate::ui::{Muted as _, TEXT_XS};

fn next_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Activity {
    #[default]
    Daily,
    Weekly,
    Cumulative,
}

pub struct UsageSettings {
    session: u64,
    request: u64,
    range: UsageRange,
    timezone: String,
    stats: Option<UsageStats>,
    loading: bool,
    dirty: bool,
    error: Option<String>,
    activity: Activity,
    heat_days_back: u64,
    trend: u64,
    by_conversation: bool,
}
impl Default for UsageSettings {
    fn default() -> Self {
        Self {
            session: next_id(),
            request: 0,
            range: UsageRange::Year,
            timezone: iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into()),
            stats: None,
            loading: false,
            dirty: false,
            error: None,
            activity: Default::default(),
            heat_days_back: 0,
            trend: 7,
            by_conversation: false,
        }
    }
}

impl Workspace {
    pub(super) fn refresh_usage(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self
            .settings
            .as_mut()
            .filter(|s| s.section == Section::Usage)
        else {
            return;
        };
        let s = &mut s.usage;
        if s.loading {
            s.dirty = true;
            return;
        }
        s.timezone = iana_time_zone::get_timezone().unwrap_or_else(|_| s.timezone.clone());
        s.loading = true;
        s.error = None;
        s.request = next_id();
        let (session, request) = (s.session, s.request);
        let call = backend.call::<StatsUsage>(UsageParams {
            range: s.range,
            timezone: s.timezone.clone(),
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                let english = this.app_settings.language == UiLanguage::English;
                let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.usage.session == session && s.usage.request == request)
                else {
                    return;
                };
                let s = &mut s.usage;
                s.loading = false;
                match result {
                    Ok(stats) => s.stats = Some(stats),
                    Err(error) => {
                        s.error = Some(tr!(
                            english,
                            "usage.failed_to_load_usage_statistics",
                            error = error
                        ))
                    }
                }
                let again = std::mem::take(&mut s.dirty);
                if again {
                    this.refresh_usage(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn usage_range(&mut self, range: UsageRange, cx: &mut Context<Self>) {
        if let Some(s) = self.settings.as_mut() {
            s.usage.range = range;
            s.usage.heat_days_back = 0;
            s.usage.stats = None;
            s.usage.loading = false;
            s.usage.dirty = false;
            s.usage.request = next_id();
        }
        self.refresh_usage(cx);
    }

    pub(super) fn usage_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(s) = self.settings.as_ref() else {
            return div().into_any_element();
        };
        let s = &s.usage;
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let mut ranges = div().flex().flex_wrap().gap(px(6.0));
        for (range, label) in [
            (UsageRange::Week, trs!(english, "usage.7_days")),
            (UsageRange::Month, trs!(english, "usage.30_days")),
            (UsageRange::Quarter, trs!(english, "usage.90_days")),
            (UsageRange::Year, trs!(english, "usage.1_year")),
            (UsageRange::All, trs!(english, "usage.all")),
        ] {
            ranges = ranges.child(
                outline_button(SharedString::from(format!("usage-range-{label}")), p)
                    .child(label)
                    .when(s.range == range, |b| b.bg(p.c(Token::Muted)))
                    .on_click(cx.listener(move |this, _, _, cx| this.usage_range(range, cx))),
            );
        }
        ranges = ranges.child(
            outline_button("refresh-usage", p)
                .child(if s.loading {
                    trs!(english, "usage.loading")
                } else {
                    trs!(english, "usage.refresh")
                })
                .on_click(cx.listener(|this, _, _, cx| this.refresh_usage(cx))),
        );
        let mut pane = div().flex().flex_col().gap(px(16.0)).child(ranges);
        if let Some(error) = &s.error {
            pane = pane.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(SharedString::from(error.clone())),
            );
        }
        let Some(stats) = &s.stats else {
            return pane
                .child(if s.loading {
                    trs!(english, "usage.loading_usage_statistics")
                } else {
                    trs!(english, "usage.no_usage_statistics_yet")
                })
                .into_any_element();
        };
        let m = &stats.totals.metrics;
        let mut summary = card(p).p(px(16.0)).gap(px(12.0));
        for row in [
            [
                ("估算费用", money(m, english)),
                ("输入 Token", compact(m.input)),
                ("输出 Token", compact(m.output)),
                (
                    "缓存 Token",
                    compact(m.cache_read.saturating_add(m.cache_write)),
                ),
            ],
            [
                ("Token 总量", compact(m.tokens)),
                (
                    "单日峰值",
                    compact(
                        stats
                            .days
                            .iter()
                            .map(|d| d.metrics.tokens)
                            .max()
                            .unwrap_or(0),
                    ),
                ),
                ("当前连续天数", stats.current_streak.to_string()),
                ("最长连续天数", stats.longest_streak.to_string()),
            ],
            [
                ("对话数", stats.sessions.to_string()),
                ("请求数", compact(m.requests)),
                ("工具调用", compact(m.tool_calls)),
                (
                    "最长对话跨度",
                    format!("{:.0} 分钟", stats.longest_session_minutes),
                ),
            ],
        ] {
            summary = summary.child(div().flex().gap(px(12.0)).children(row.into_iter().map(
                |(label, value)| {
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(div().text_size(px(TEXT_XS)).muted(p).child(label))
                        .child(div().text_size(px(17.0)).child(SharedString::from(value)))
                },
            )));
        }
        summary = summary.child(
            div()
                .text_size(px(TEXT_XS))
                .muted(p)
                .child(SharedString::from(format!(
                    "缓存读取 {} · 写入 {} · 命中 {}；按当前模型目录估算 Token 费用，不含托管搜索等额外费用，可能与账单不同。",
                    compact(m.cache_read),
                    compact(m.cache_write),
                    if m.input > 0 || m.cache_read > 0 || m.cache_write > 0 {
                        format!(
                            "{:.1}%",
                            m.cache_read as f64
                                / (m.input as f64 + m.cache_read as f64 + m.cache_write as f64)
                                * 100.0
                        )
                    } else {
                        "—".into()
                    }
                ))),
        );
        if m.unpriced_requests > 0 {
            summary = summary.child(div().text_size(px(TEXT_XS)).muted(p).child(
                SharedString::from(format!(
                    "{} 次请求缺少可用价格或用量；费用仅包含可估算部分。",
                    m.unpriced_requests
                )),
            ));
        }
        summary = summary.child(
            div()
                .text_size(px(TEXT_XS))
                .muted(p)
                .child("以已记录的对话回复为准；辅助请求和压缩摘要不计入。"),
        );
        if stats.invalid_timestamps > 0 {
            summary = summary.child(div().text_size(px(TEXT_XS)).child(SharedString::from(
                format!(
                    "{} 条记录时间无效，未纳入日期统计。",
                    stats.invalid_timestamps
                ),
            )));
        }
        pane = pane
            .child(summary)
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(SharedString::from(format!(
                        "{} 至 {} · {} · 已删除对话的用量仍保留",
                        stats.from, stats.to, stats.timezone
                    ))),
            );
        pane = pane.child(self.usage_breakdown(stats, s.by_conversation, cx));
        let mut modes = div()
            .flex()
            .gap(px(6.0))
            .child(trs!(english, "usage.token_activity"));
        for (mode, label) in [
            (Activity::Daily, trs!(english, "usage.daily")),
            (Activity::Weekly, trs!(english, "usage.weekly")),
            (Activity::Cumulative, trs!(english, "usage.cumulative")),
        ] {
            modes = modes.child(
                outline_button(SharedString::from(format!("activity-{label}")), p)
                    .child(label)
                    .when(s.activity == mode, |b| b.bg(p.c(Token::Muted)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(s) = this.settings.as_mut() {
                            s.usage.activity = mode;
                        }
                        cx.notify();
                    })),
            );
        }
        if let Some(calendar) = calendar(stats, s.activity, s.heat_days_back) {
            let mut navigation =
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(SharedString::from(format!(
                        "{} 至 {}",
                        calendar.from, calendar.to
                    )));
            if calendar.earlier {
                navigation = navigation.child(
                    outline_button("usage-earlier", p)
                        .child(trs!(english, "usage.earlier"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(s) = this.settings.as_mut() {
                                s.usage.heat_days_back += 365;
                            }
                            cx.notify();
                        })),
                );
            }
            if s.heat_days_back > 0 {
                navigation = navigation.child(
                    outline_button("usage-later", p)
                        .child(trs!(english, "usage.later"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(s) = this.settings.as_mut() {
                                s.usage.heat_days_back = s.usage.heat_days_back.saturating_sub(365);
                            }
                            cx.notify();
                        })),
                );
            }
            pane = pane.child(
                card(p)
                    .p(px(16.0))
                    .gap(px(12.0))
                    .child(modes)
                    .child(navigation)
                    .child(heatmap(calendar, p, english)),
            );
        }
        let mut trend_head = div()
            .flex()
            .gap(px(8.0))
            .items_center()
            .child(trs!(english, "usage.daily_token_trend"));
        for span in [7, 30] {
            trend_head = trend_head.child(
                outline_button(SharedString::from(format!("usage-trend-{span}")), p)
                    .child(SharedString::from(format!("{span} 天")))
                    .when(s.trend == span, |b| b.bg(p.c(Token::Muted)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(s) = this.settings.as_mut() {
                            s.usage.trend = span;
                        }
                        cx.notify();
                    })),
            );
        }
        pane.child(
            card(p)
                .p(px(16.0))
                .gap(px(12.0))
                .child(trend_head)
                .child(trend(stats, s.trend, p, english)),
        )
        .child(model_usage(stats, p, english))
        .into_any_element()
    }

    fn usage_breakdown(
        &self,
        stats: &UsageStats,
        by_conversation: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let mut header = div()
            .flex()
            .gap(px(8.0))
            .items_center()
            .child(trs!(english, "usage.cost_breakdown"));
        for (conversation, label) in [
            (false, trs!(english, "usage.by_project")),
            (true, trs!(english, "usage.by_chat")),
        ] {
            header = header.child(
                outline_button(SharedString::from(format!("usage-group-{label}")), p)
                    .child(label)
                    .when(conversation == by_conversation, |b| b.bg(p.c(Token::Muted)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(s) = this.settings.as_mut() {
                            s.usage.by_conversation = conversation;
                        }
                        cx.notify();
                    })),
            );
        }
        let mut groups = BTreeMap::<String, (String, UsageMetrics)>::new();
        for c in &stats.conversations {
            let (key, label) = if by_conversation {
                (
                    c.session_id.clone(),
                    c.title
                        .clone()
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "已删除或不可用对话".into()),
                )
            } else if let Some(project) = &c.project {
                (
                    project.clone(),
                    self.projects
                        .iter()
                        .find(|p| &p.path == project)
                        .map(|p| p.name.clone())
                        .unwrap_or_else(|| project.clone()),
                )
            } else if c.thread_id.is_some() {
                ("scratch".into(), "未关联项目".into())
            } else {
                ("deleted".into(), "已删除或不可用对话".into())
            };
            let group = groups
                .entry(key)
                .or_insert_with(|| (label, UsageMetrics::default()));
            merge(&mut group.1, &c.metrics);
        }
        let mut groups: Vec<_> = groups.into_values().collect();
        groups.sort_by(|a, b| {
            b.1.cost
                .unwrap_or(0.0)
                .total_cmp(&a.1.cost.unwrap_or(0.0))
                .then_with(|| b.1.tokens.cmp(&a.1.tokens))
        });
        let rows = div()
            .id("usage-breakdown-rows")
            .max_h(px(288.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .children(
                groups
                    .into_iter()
                    .map(|(label, metrics)| usage_row(label, &metrics, p, english)),
            );
        card(p)
            .p(px(16.0))
            .gap(px(12.0))
            .child(header)
            .child(rows)
            .into_any_element()
    }
}

fn compact(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0)
    } else if value >= 1000 {
        format!("{:.1}K", value as f64 / 1000.0)
    } else {
        value.to_string()
    }
}
fn money(metrics: &UsageMetrics, english: bool) -> String {
    metrics
        .cost
        .map(|c| {
            format!(
                "${c:.4}{}",
                if metrics.unpriced_requests > 0 {
                    trs!(english, "usage.partial")
                } else {
                    ""
                }
            )
        })
        .unwrap_or_else(|| "—".into())
}
fn merge(to: &mut UsageMetrics, from: &UsageMetrics) {
    to.input = to.input.saturating_add(from.input);
    to.output = to.output.saturating_add(from.output);
    to.cache_read = to.cache_read.saturating_add(from.cache_read);
    to.cache_write = to.cache_write.saturating_add(from.cache_write);
    to.tool_calls = to.tool_calls.saturating_add(from.tool_calls);
    to.tokens = to.tokens.saturating_add(from.tokens);
    to.requests = to.requests.saturating_add(from.requests);
    to.unpriced_requests = to.unpriced_requests.saturating_add(from.unpriced_requests);
    if let Some(cost) = from.cost {
        let sum = to.cost.unwrap_or(0.0) + cost;
        to.cost = Some(if sum.is_finite() { sum } else { f64::MAX });
    }
}
fn usage_row(label: String, metrics: &UsageMetrics, p: &Palette, english: bool) -> Div {
    div()
        .flex()
        .gap(px(12.0))
        .items_center()
        .text_size(px(TEXT_XS))
        .child(div().flex_1().min_w_0().child(crate::ui::truncate(label)))
        .child(SharedString::from(tr!(
            english,
            "usage.tokens_requests",
            arg1 = compact(metrics.tokens),
            arg2 = metrics.requests
        )))
        .child(SharedString::from(money(metrics, english)))
        .text_color(p.c(Token::Foreground))
}

struct HeatCell {
    date: NaiveDate,
    value: u64,
    day_tokens: u64,
    in_range: bool,
}
struct Calendar {
    from: NaiveDate,
    to: NaiveDate,
    earlier: bool,
    weeks: Vec<Vec<HeatCell>>,
}
fn calendar(stats: &UsageStats, view: Activity, back: u64) -> Option<Calendar> {
    let start: NaiveDate = stats.from.parse().ok()?;
    let end: NaiveDate = stats.to.parse().ok()?;
    let to = end.checked_sub_days(Days::new(back))?.max(start);
    let from = to.checked_sub_days(Days::new(364))?.max(start);
    let first = from.checked_sub_days(Days::new(from.weekday().num_days_from_sunday() as u64))?;
    let counts: BTreeMap<_, _> = stats
        .days
        .iter()
        .map(|d| (d.date.as_str(), d.metrics.tokens))
        .collect();
    let mut cumulative = stats
        .days
        .iter()
        .filter(|d| d.date < from.to_string())
        .fold(0u64, |sum, d| sum.saturating_add(d.metrics.tokens));
    let mut weeks = Vec::new();
    let mut cursor = first;
    while cursor <= to {
        let mut cells = Vec::new();
        for _ in 0..7 {
            let date = cursor;
            let day_tokens = counts.get(date.to_string().as_str()).copied().unwrap_or(0);
            let in_range = date >= from && date <= to;
            if in_range {
                cumulative = cumulative.saturating_add(day_tokens);
            }
            cells.push(HeatCell {
                date,
                day_tokens,
                value: if view == Activity::Cumulative {
                    cumulative
                } else {
                    day_tokens
                },
                in_range,
            });
            cursor = cursor.succ_opt()?;
        }
        if view == Activity::Weekly {
            let total = cells
                .iter()
                .fold(0u64, |sum, c| sum.saturating_add(c.day_tokens));
            for cell in &mut cells {
                cell.value = total;
            }
        }
        weeks.push(cells);
    }
    Some(Calendar {
        from,
        to,
        earlier: from > start,
        weeks,
    })
}
fn heatmap(calendar: Calendar, p: &Palette, english: bool) -> AnyElement {
    let mut months: Vec<(u32, usize)> = Vec::new();
    for week in &calendar.weeks {
        let month = week[0].date.month();
        if let Some((last, count)) = months.last_mut()
            && *last == month
        {
            *count += 1;
        } else {
            months.push((month, 1));
        }
    }
    let headings = div()
        .flex()
        .ml(px(22.0))
        .children(months.into_iter().map(|(month, count)| {
            div()
                .flex_none()
                .w(px(count as f32 * 12.0))
                .text_size(px(10.0))
                .child(SharedString::from(if count >= 3 {
                    crate::workspace::static_text(english, &format!("usage.month_{month}"))
                        .to_string()
                } else {
                    String::new()
                }))
        }));
    let labels = div()
        .flex_none()
        .w(px(20.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .children((0..7).map(|day| {
            let label = crate::workspace::static_text(english, &format!("usage.weekday_{day}"));
            div()
                .h(px(10.0))
                .line_height(px(10.0))
                .text_size(px(9.0))
                .child(label)
        }));
    let mut values: Vec<_> = calendar
        .weeks
        .iter()
        .flatten()
        .filter(|c| c.in_range && c.value > 0)
        .map(|c| c.value)
        .collect();
    values.sort_unstable();
    let thresholds = [0.25, 0.5, 0.75].map(|q| {
        values
            .get((values.len() as f64 * q) as usize)
            .copied()
            .unwrap_or(0)
    });
    let mut columns = div().flex().gap(px(2.0));
    for week in calendar.weeks {
        columns = columns.child(div().flex_none().flex().flex_col().gap(px(2.0)).children(
            week.into_iter().map(|cell| {
                let level = if cell.value == 0 {
                    0
                } else if cell.value <= thresholds[0] {
                    1
                } else if cell.value <= thresholds[1] {
                    2
                } else if cell.value <= thresholds[2] {
                    3
                } else {
                    4
                };
                let color = if level == 0 || !cell.in_range {
                    p.c(Token::Muted)
                } else {
                    p.c(Token::Primary)
                        .opacity([0.0, 0.15, 0.3, 0.6, 1.0][level])
                };
                div()
                    .id(SharedString::from(format!("usage-day-{}", cell.date)))
                    .w(px(10.0))
                    .h(px(10.0))
                    .rounded(px(2.0))
                    .bg(color)
                    .tooltip(move |window, cx| {
                        gpui_kit::component::tooltip::Tooltip::new(SharedString::from(tr!(
                            english,
                            "usage.today_tokens_this_view",
                            arg1 = cell.date,
                            arg2 = cell.day_tokens,
                            arg3 = cell.value
                        )))
                        .build(window, cx)
                    })
            }),
        ));
    }
    div()
        .id("usage-calendar")
        .overflow_x_scroll()
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(headings)
                .child(div().flex().gap(px(2.0)).child(labels).child(columns)),
        )
        .into_any_element()
}

fn colors(p: &Palette) -> Vec<Hsla> {
    [
        Token::Chart1,
        Token::Chart2,
        Token::Chart3,
        Token::Chart4,
        Token::Chart5,
    ]
    .map(|t| p.c(t))
    .to_vec()
}
fn trend(stats: &UsageStats, span: u64, p: &Palette, english: bool) -> AnyElement {
    let Some(to) = stats.to.parse::<NaiveDate>().ok() else {
        return div().into_any_element();
    };
    let Some(mut cursor) = to.checked_sub_days(Days::new(span.saturating_sub(1))) else {
        return div().into_any_element();
    };
    if let Ok(from) = stats.from.parse() {
        cursor = cursor.max(from);
    }
    let mut dates = Vec::new();
    while cursor <= to {
        dates.push(cursor.to_string());
        let Some(next) = cursor.succ_opt() else { break };
        cursor = next;
    }
    let labels: Vec<_> = stats
        .models
        .iter()
        .take(5)
        .map(|m| m.model.clone())
        .collect();
    let series: Vec<Vec<u64>> = stats
        .models
        .iter()
        .take(5)
        .map(|m| {
            dates
                .iter()
                .map(|d| {
                    m.days
                        .iter()
                        .find(|day| &day.date == d)
                        .map_or(0, |d| d.metrics.tokens)
                })
                .collect()
        })
        .collect();
    let peak = series.iter().flatten().copied().max().unwrap_or(0).max(1);
    let chart_colors = colors(p);
    let border = p.c(Token::Border);
    let mut legend = div().flex().flex_wrap().gap(px(12.0));
    for (i, label) in labels.iter().enumerate() {
        legend = legend.child(
            div()
                .text_size(px(TEXT_XS))
                .text_color(chart_colors[i])
                .child(SharedString::from(label.clone())),
        );
    }
    let tips: Vec<_> = dates
        .iter()
        .enumerate()
        .map(|(i, date)| {
            format!(
                "{date}\n{}",
                labels
                    .iter()
                    .enumerate()
                    .map(|(j, label)| format!("{label}: {}", series[j][i]))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        })
        .collect();
    let plot = canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let w = f32::from(bounds.size.width).max(1.0);
            let h = f32::from(bounds.size.height).max(1.0);
            for fraction in [0.0, 0.5, 1.0] {
                let mut path = PathBuilder::stroke(px(1.0));
                let y = bounds.origin.y + px(h * fraction);
                path.move_to(point(bounds.origin.x, y));
                path.line_to(point(bounds.origin.x + px(w), y));
                if let Ok(path) = path.build() {
                    window.paint_path(path, border);
                }
            }
            for (j, values) in series.iter().enumerate() {
                let mut path = PathBuilder::stroke(px(2.0));
                for (i, value) in values.iter().enumerate() {
                    let point = point(
                        bounds.origin.x
                            + px(w * i as f32 / values.len().saturating_sub(1).max(1) as f32),
                        bounds.origin.y + px(h * (1.0 - *value as f32 / peak as f32)),
                    );
                    if i == 0 {
                        path.move_to(point);
                    } else {
                        path.line_to(point);
                    }
                }
                if let Ok(path) = path.build() {
                    window.paint_path(path, chart_colors[j]);
                }
            }
        },
    )
    .size_full();
    div()
        .flex()
        .flex_col()
        .gap(px(8.0))
        .child(legend)
        .child(
            div().h(px(180.0)).w_full().relative().child(plot).child(
                div()
                    .absolute()
                    .size_full()
                    .flex()
                    .children(tips.into_iter().enumerate().map(|(i, tip)| {
                        div()
                            .id(SharedString::from(format!("usage-tip-{i}")))
                            .flex_1()
                            .h_full()
                            .tooltip(move |window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new(SharedString::from(
                                    tip.clone(),
                                ))
                                .build(window, cx)
                            })
                    })),
            ),
        )
        .child(
            div()
                .text_size(px(TEXT_XS))
                .muted(p)
                .child(SharedString::from(tr!(
                    english,
                    "usage.peak_tokens",
                    arg1 = dates.first().cloned().unwrap_or_default(),
                    arg2 = stats.to,
                    arg3 = compact(peak)
                ))),
        )
        .into_any_element()
}

fn model_usage(stats: &UsageStats, p: &Palette, english: bool) -> AnyElement {
    let mut shares: Vec<_> = stats
        .models
        .iter()
        .take(5)
        .map(|m| {
            (
                format!(
                    "{} · {}",
                    m.model,
                    m.provider_name.as_deref().unwrap_or(&m.provider)
                ),
                m.metrics.tokens,
            )
        })
        .collect();
    let shown = shares
        .iter()
        .fold(0u64, |sum, (_, n)| sum.saturating_add(*n));
    let other = stats.totals.metrics.tokens.saturating_sub(shown);
    if other > 0 {
        shares.push((trs!(english, "usage.other_models").into(), other));
    }
    let total = stats.totals.metrics.tokens;
    let segments = shares.clone();
    let chart_colors = colors(p);
    let track = p.c(Token::Muted);
    let ring = canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let center = bounds.center();
            let mut from = 0.0f32;
            let mut draw = |a: f32, b: f32, color| {
                let mut path = PathBuilder::stroke(px(18.0));
                for i in 0..=80 {
                    let theta = (a + (b - a) * i as f32 / 80.0) * std::f32::consts::TAU
                        - std::f32::consts::FRAC_PI_2;
                    let point = point(
                        center.x + px(62.0 * theta.cos()),
                        center.y + px(62.0 * theta.sin()),
                    );
                    if i == 0 {
                        path.move_to(point);
                    } else {
                        path.line_to(point);
                    }
                }
                if let Ok(path) = path.build() {
                    window.paint_path(path, color);
                }
            };
            draw(0.0, 0.999, track);
            if total > 0 {
                for (i, (_, tokens)) in segments.iter().enumerate() {
                    let to = (from + *tokens as f32 / total as f32).min(1.0);
                    if to > from {
                        draw(from, to, chart_colors[i % chart_colors.len()]);
                    }
                    from = to;
                }
            }
        },
    )
    .size_full();
    let mut legend = div().flex_1().min_w_0().flex().flex_col().gap(px(8.0));
    let legend_colors = colors(p);
    for (index, (label, tokens)) in shares.into_iter().enumerate() {
        legend = legend.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(
                    div()
                        .size(px(7.0))
                        .flex_none()
                        .rounded_full()
                        .bg(legend_colors[index % legend_colors.len()]),
                )
                .text_size(px(TEXT_XS))
                .child(SharedString::from(format!(
                    "{label} · {} · {:.1}%",
                    compact(tokens),
                    tokens as f64 / total.max(1) as f64 * 100.0
                ))),
        );
    }
    card(p)
        .p(px(16.0))
        .gap(px(12.0))
        .child(trs!(english, "usage.model_usage"))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(16.0))
                .child(
                    div()
                        .size(px(160.0))
                        .flex_none()
                        .relative()
                        .child(ring)
                        .child(
                            div()
                                .absolute()
                                .size_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(SharedString::from(compact(total))),
                        ),
                )
                .child(legend),
        )
        .child(
            div()
                .id("usage-model-rows")
                .max_h(px(320.0))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .children(stats.models.iter().map(|m| {
                    usage_row(
                        format!(
                            "{} · {}",
                            m.provider_name.as_deref().unwrap_or(&m.provider),
                            m.model
                        ),
                        &m.metrics,
                        p,
                        english,
                    )
                })),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{Activity, calendar, merge, money};
    use chrono::Days;
    use fv_protocol::usage::*;

    fn stats() -> UsageStats {
        UsageStats {
            range: UsageRange::All,
            timezone: "UTC".into(),
            from: "1600-01-01".into(),
            to: "2026-10-26".into(),
            totals: Default::default(),
            days: vec![
                UsageDay {
                    date: "2025-10-26".into(),
                    metrics: UsageMetrics {
                        tokens: 7,
                        ..Default::default()
                    },
                },
                UsageDay {
                    date: "2025-10-28".into(),
                    metrics: UsageMetrics {
                        tokens: 9,
                        ..Default::default()
                    },
                },
                UsageDay {
                    date: "2026-10-26".into(),
                    metrics: UsageMetrics {
                        tokens: 11,
                        ..Default::default()
                    },
                },
            ],
            models: vec![],
            conversations: vec![],
            sessions: 0,
            longest_session_minutes: 0.0,
            current_streak: 0,
            longest_streak: 0,
            invalid_timestamps: 0,
        }
    }

    #[test]
    fn long_history_pages_are_bounded_and_adjacent_without_losing_cumulative_totals() {
        let stats = stats();
        let current = calendar(&stats, Activity::Cumulative, 0).unwrap();
        let previous = calendar(&stats, Activity::Cumulative, 365).unwrap();
        assert!(current.earlier && previous.earlier);
        assert!(current.weeks.len() <= 53 && previous.weeks.len() <= 53);
        assert_eq!(
            previous.to.checked_add_days(Days::new(1)).unwrap(),
            current.from
        );
        let first = current.weeks.iter().flatten().find(|c| c.in_range).unwrap();
        assert_eq!(first.date.to_string(), "2025-10-27");
        assert_eq!(first.value, 7);
        let mut year = stats.clone();
        year.range = UsageRange::Year;
        year.from = "2025-10-27".into();
        let calendar = calendar(&year, Activity::Daily, 0).unwrap();
        assert_eq!(calendar.from.to_string(), year.from);
        assert!(
            !calendar.earlier,
            "the default yearly range must not hide its first day behind pagination"
        );
        assert_eq!(
            current
                .weeks
                .iter()
                .flatten()
                .find(|c| c.date.to_string() == "2026-10-26")
                .unwrap()
                .value,
            27
        );
    }

    #[test]
    fn weekly_values_include_the_full_week_across_a_page_boundary_and_daily_values_stay_daily() {
        let stats = stats();
        let weekly = calendar(&stats, Activity::Weekly, 0).unwrap();
        assert_eq!(
            weekly.weeks[0].iter().find(|c| c.in_range).unwrap().value,
            16
        );
        let daily = calendar(&stats, Activity::Daily, 0).unwrap();
        assert_eq!(daily.weeks[0].iter().find(|c| c.in_range).unwrap().value, 0);
        let mut invalid = stats;
        invalid.to = "invalid".into();
        assert!(calendar(&invalid, Activity::Daily, 0).is_none());
    }

    #[test]
    fn breakdown_preserves_unknown_costs_and_all_token_buckets() {
        let unknown = UsageMetrics {
            input: 10,
            output: 20,
            cache_read: 30,
            cache_write: 40,
            tokens: 100,
            requests: 1,
            tool_calls: 2,
            cost: None,
            unpriced_requests: 1,
        };
        let mut total = UsageMetrics::default();
        merge(&mut total, &unknown);
        assert_eq!(money(&total, false), "—");
        assert_eq!(total, unknown);
        merge(
            &mut total,
            &UsageMetrics {
                tokens: 3,
                requests: 1,
                cost: Some(0.125),
                ..Default::default()
            },
        );
        assert_eq!(total.tokens, 103);
        assert_eq!(total.input, 10);
        assert_eq!(total.unpriced_requests, 1);
        assert!(money(&total, false).contains("部分"));
    }
}
