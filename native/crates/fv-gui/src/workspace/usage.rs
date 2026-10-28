//! 设置 → 使用统计. Shared usage query, local presentation, laid out as Electron's
//! `usage-settings.tsx` + `usage-breakdown.tsx`: header and pill, the cost summary and its
//! source table, the five-cell strip, the Token activity heatmap, the daily trend and the
//! model donut. Every async result belongs to one settings instance.
use std::collections::BTreeMap;

use crate::ui::px;
use chrono::{Datelike, Days, NaiveDate};
use fv_protocol::methods::StatsUsage;
use fv_protocol::types::UiLanguage;
use fv_protocol::usage::*;
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::settings::{Section, menu_item, outline_button, popover};
use crate::theme::Palette;
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon};

fn next_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Tailwind `text-lg` / `text-xl`.
const TEXT_LG: f32 = 18.0;
const TEXT_XL: f32 = 20.0;

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
    range_menu: bool,
    /// Dev capture only: start the pane at the Token activity card.
    capture_tail: bool,
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
            range_menu: false,
            capture_tail: false,
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
                    Err(error) => s.error = Some(error.to_string()),
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
            s.usage.range_menu = false;
            if s.usage.range == range {
                cx.notify();
                return;
            }
            s.usage.range = range;
            s.usage.heat_days_back = 0;
            s.usage.stats = None;
            s.usage.loading = false;
            s.usage.dirty = false;
            s.usage.request = next_id();
        }
        self.refresh_usage(cx);
        cx.notify();
    }

    /// Dev capture: the harness has no host to ask, so the pane is handed the same sample
    /// Electron's mock draws (`USAGE` in `mock/preview-data.ts`).
    /// `usage-en` switches the interface to English; `-tail` leaves out the sections above the
    /// heatmap so a window no taller than the screen can show the charts.
    pub(super) fn usage_fixture(&mut self, name: &str) {
        if name.contains("-en") {
            self.app_settings.language = UiLanguage::English;
        }
        if self.backend.is_some() {
            return;
        }
        let project = self.projects.first().map(|p| p.path.clone());
        if let Some(s) = self.settings.as_mut() {
            s.usage.stats = Some(sample_stats(project));
            s.usage.capture_tail = name.ends_with("-tail");
        }
    }

    pub(super) fn usage_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(s) = self.settings.as_ref() else {
            return div().into_any_element();
        };
        let s = &s.usage;
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let stats = s.stats.as_ref();

        // `<header>`: the settings view leaves its own title out for this pane.
        let header = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(12.0))
            .child(
                div()
                    .text_size(px(TEXT_XL))
                    .line_height(px(28.0))
                    .font_weight(FontWeight::MEDIUM)
                    .child(trs!(english, "usage.title")),
            )
            .child(
                div()
                    .rounded_full()
                    .bg(p.c(Token::Muted))
                    .px(px(10.0))
                    .py(px(4.0))
                    .text_size(px(TEXT_XS))
                    .line_height(px(16.0))
                    .font_weight(FontWeight::MEDIUM)
                    .child(trs!(english, "usage.app_usage")),
            );

        let mut pane = div().flex().flex_col().gap(px(24.0));
        if !s.capture_tail {
            pane = pane.child(header);
            if let Some(stats) = stats {
                pane = pane.child(self.usage_breakdown(stats, s.by_conversation, cx));
            }
            pane = pane.child(summary_strip(stats, p, english));
        }

        // Token 活动
        let activity_tabs = tabs(
            "usage-activity",
            &[
                (Activity::Daily, trs!(english, "usage.daily")),
                (Activity::Weekly, trs!(english, "usage.weekly")),
                (Activity::Cumulative, trs!(english, "usage.cumulative")),
            ],
            s.activity,
            12.0,
            p,
            cx,
            |s, v| s.activity = v,
        );
        let activity_head = div()
            .mb(px(16.0))
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap(px(10.0))
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(trs!(english, "usage.token_activity")),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(self.usage_range_select(s, cx))
                    .child(activity_tabs),
            );
        let activity_body = if s.error.is_some() {
            div()
                .py(px(32.0))
                .flex()
                .flex_col()
                .items_center()
                .text_size(px(TEXT_SM))
                .muted(p)
                .child(trs!(english, "usage.load_failed"))
                .child(
                    outline_button("usage-retry", p)
                        .mt(px(8.0))
                        .text_color(p.c(Token::Foreground))
                        .child(trs!(english, "usage.retry"))
                        .on_click(cx.listener(|this, _, _, cx| this.refresh_usage(cx))),
                )
                .into_any_element()
        } else if let Some(calendar) =
            stats.and_then(|st| calendar(st, s.activity, s.heat_days_back))
        {
            div()
                .when(s.loading, |d| d.opacity(0.5))
                .child(heatmap(calendar, s.heat_days_back > 0, p, english, cx))
                .into_any_element()
        } else {
            skeleton(192.0, p).into_any_element()
        };
        pane = pane.child(panel(p, 0.35).child(activity_head).child(activity_body));

        // 每日 Token 趋势图
        let trend_tabs = tabs(
            "usage-trend",
            &[
                (7, trs!(english, "usage.range_7_short")),
                (30, trs!(english, "usage.range_30_short")),
            ],
            s.trend,
            12.0,
            p,
            cx,
            |s, v| s.trend = v,
        );
        pane = pane.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .px(px(4.0))
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .justify_between()
                        .gap(px(10.0))
                        .child(
                            div()
                                .text_size(px(TEXT_SM))
                                .font_weight(FontWeight::MEDIUM)
                                .child(trs!(english, "usage.daily_token_trend")),
                        )
                        .child(trend_tabs),
                )
                .child(panel(p, 0.35).child(match stats {
                    Some(stats) => trend(stats, s.trend, p, english),
                    None => skeleton(256.0, p).into_any_element(),
                })),
        );

        if let Some(stats) = stats {
            pane = pane.child(model_usage(stats, p, english));
        }
        pane.pb(px(32.0)).into_any_element()
    }

    /// `<Select size="sm" className="w-28 bg-background/70">` and its list.
    fn usage_range_select(&self, s: &UsageSettings, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let label = |range| match range {
            UsageRange::Week => trs!(english, "usage.range_7d"),
            UsageRange::Month => trs!(english, "usage.range_30d"),
            UsageRange::Quarter => trs!(english, "usage.range_90d"),
            UsageRange::Year => trs!(english, "usage.range_365d"),
            UsageRange::All => trs!(english, "usage.range_all"),
        };
        let trigger = div()
            .id("usage-range")
            .h(px(28.0))
            .w(px(112.0))
            .pl(px(10.0))
            .pr(px(8.0))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(6.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(p.c(Token::Input))
            .bg(p.c(Token::Background).opacity(0.7))
            .text_size(px(TEXT_SM))
            .cursor_pointer()
            .child(ui::truncate(label(s.range)))
            .child(icon("unfold-more", 16.0, p.c(Token::MutedForeground)))
            .on_click(cx.listener(|this, _, _, cx| {
                if let Some(s) = this.settings.as_mut() {
                    s.usage.range_menu = !s.usage.range_menu;
                }
                cx.notify();
            }));
        let hover = p.c(Token::Accent);
        let mut menu = popover(p)
            .absolute()
            .top(px(32.0))
            .left(px(0.0))
            .w(px(144.0))
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                if let Some(s) = this.settings.as_mut() {
                    s.usage.range_menu = false;
                }
                cx.notify();
            }));
        for range in [
            UsageRange::Week,
            UsageRange::Month,
            UsageRange::Quarter,
            UsageRange::Year,
            UsageRange::All,
        ] {
            let active = range == s.range;
            menu = menu.child(
                menu_item(
                    SharedString::from(format!("usage-range-{}", label(range))),
                    false,
                    hover,
                )
                .justify_between()
                .child(label(range))
                .when(active, |d| {
                    d.child(icon("tick02", 14.0, p.c(Token::Foreground)))
                })
                .on_click(cx.listener(move |this, _, _, cx| this.usage_range(range, cx))),
            );
        }
        div()
            .relative()
            .child(trigger)
            .when(s.range_menu, |d| d.child(ui::float(menu)))
            .into_any_element()
    }

    /// `UsageBreakdown`: the cost summary, then 费用来源 by project or by chat.
    fn usage_breakdown(
        &self,
        stats: &UsageStats,
        by_conversation: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let m = &stats.totals.metrics;
        let cell = |label: &'static str, value: String| {
            div()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .text_size(px(TEXT_XS))
                        .line_height(px(16.0))
                        .muted(p)
                        .child(label),
                )
                .child(
                    div()
                        .mt(px(4.0))
                        .text_size(px(TEXT_LG))
                        .line_height(px(28.0))
                        .font_weight(FontWeight::MEDIUM)
                        .child(SharedString::from(value)),
                )
        };
        let note = |text: String| {
            div()
                .mt(px(4.0))
                .text_size(px(TEXT_XS))
                .line_height(px(16.0))
                .muted(p)
                .child(SharedString::from(text))
        };
        let rate = (100.0 * m.cache_read as f64
            / (m.input + m.cache_read + m.cache_write).max(1) as f64)
            .round();
        let mut summary = panel(p, 0.35)
            .child(
                div()
                    .flex()
                    .gap(px(16.0))
                    .child(cell(
                        trs!(english, "usage.estimated_cost"),
                        money(m, english),
                    ))
                    .child(cell(
                        trs!(english, "usage.input_tokens"),
                        intl_compact(m.input, english),
                    ))
                    .child(cell(
                        trs!(english, "usage.output_tokens"),
                        intl_compact(m.output, english),
                    ))
                    .child(cell(
                        trs!(english, "usage.cache_tokens"),
                        intl_compact(m.cache_read.saturating_add(m.cache_write), english),
                    )),
            )
            .child(note(trs!(english, "usage.estimate_hint").into()).mt(px(12.0)))
            .child(note(tr!(
                english,
                "usage.cache_detail",
                read = intl_compact(m.cache_read, english),
                write = intl_compact(m.cache_write, english),
                rate = rate
            )));
        if m.unpriced_requests > 0 {
            summary = summary.child(note(tr!(
                english,
                "usage.unpriced",
                count = m.unpriced_requests
            )));
        }
        if stats.invalid_timestamps > 0 {
            summary = summary.child(note(tr!(
                english,
                "usage.invalid_timestamps",
                count = stats.invalid_timestamps
            )));
        }

        let mut groups = BTreeMap::<String, (String, UsageMetrics)>::new();
        for c in &stats.conversations {
            let unavailable = || trs!(english, "usage.unavailable_chat").to_string();
            let (key, label) = if by_conversation {
                (
                    c.session_id.clone(),
                    c.title
                        .clone()
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(unavailable),
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
                ("scratch".into(), trs!(english, "usage.scratch").into())
            } else {
                ("deleted".into(), unavailable())
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

        let mut section = div().flex().flex_col().gap(px(12.0)).child(summary);
        if groups.is_empty() {
            return section.into_any_element();
        }
        let group_tabs = tabs(
            "usage-group",
            &[
                (false, trs!(english, "usage.by_project")),
                (true, trs!(english, "usage.by_conversation")),
            ],
            by_conversation,
            6.0,
            p,
            cx,
            |s, v| s.by_conversation = v,
        );
        let border = p.c(Token::Border);
        let row = |first: SharedString, second: SharedString, third: SharedString| {
            div()
                .flex()
                .items_center()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .p(px(12.0))
                        .child(ui::truncate(first)),
                )
                .child(
                    div()
                        .w(relative(0.2))
                        .flex_none()
                        .p(px(12.0))
                        .flex()
                        .justify_end()
                        .child(second),
                )
                .child(
                    div()
                        .w(relative(0.37))
                        .flex_none()
                        .p(px(12.0))
                        .flex()
                        .justify_end()
                        .child(third),
                )
        };
        let count = groups.len();
        let table = div()
            .rounded(px(8.0))
            .border_1()
            .border_color(border)
            .overflow_hidden()
            .child(
                row(
                    trs!(
                        english,
                        if by_conversation {
                            "usage.by_conversation"
                        } else {
                            "usage.by_project"
                        }
                    )
                    .into(),
                    "Token".into(),
                    trs!(english, "usage.estimated_cost").into(),
                )
                .border_b_1()
                .border_color(border)
                .text_size(px(TEXT_XS))
                .line_height(px(16.0))
                .font_weight(FontWeight::SEMIBOLD)
                .muted(p),
            )
            .child(
                div()
                    .id("usage-breakdown-rows")
                    .max_h(px(288.0 - 41.0))
                    .overflow_y_scroll()
                    .children(groups.into_iter().enumerate().map(|(i, (label, metrics))| {
                        row(
                            label.into(),
                            intl_compact(metrics.tokens, english).into(),
                            money(&metrics, english).into(),
                        )
                        .text_size(px(TEXT_SM))
                        .line_height(px(20.0))
                        .when(i + 1 < count, |d| d.border_b_1().border_color(border))
                    })),
            );
        section = section
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .font_weight(FontWeight::MEDIUM)
                            .child(trs!(english, "usage.cost_breakdown")),
                    )
                    .child(group_tabs),
            )
            .child(table);
        section.into_any_element()
    }
}

/// `rounded-xl bg-muted/<alpha> p-4`.
fn panel(p: &Palette, alpha: f32) -> Div {
    div()
        .rounded(px(12.0))
        .bg(p.c(Token::Muted).opacity(alpha))
        .p(px(16.0))
        .flex()
        .flex_col()
}

/// The `animate-pulse rounded-xl bg-muted/50` placeholder, held still.
fn skeleton(height: f32, p: &Palette) -> Div {
    div()
        .h(px(height))
        .rounded(px(12.0))
        .bg(p.c(Token::Muted).opacity(0.5))
}

/// shadcn `<Tabs><TabsList>`: a muted 32px track, the active trigger lifted onto the page.
#[allow(clippy::too_many_arguments)]
fn tabs<T: Copy + PartialEq + 'static>(
    id: &'static str,
    items: &[(T, &'static str)],
    active: T,
    pad: f32,
    p: &Palette,
    cx: &mut Context<Workspace>,
    set: fn(&mut UsageSettings, T),
) -> Div {
    let foreground = p.c(Token::Foreground);
    let dark = p.is_dark();
    let mut list = div()
        .flex_none()
        .h(px(32.0))
        .p(px(3.0))
        .rounded(px(8.0))
        .bg(p.c(Token::Muted))
        .flex()
        .items_center();
    for (i, (value, label)) in items.iter().copied().enumerate() {
        let on = value == active;
        list = list.child(
            div()
                .id(SharedString::from(format!("{id}-{i}")))
                .h(px(25.0))
                .px(px(pad))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .border_1()
                .border_color(transparent_black())
                .text_size(px(TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .whitespace_nowrap()
                .cursor_pointer()
                .text_color(if on {
                    foreground
                } else if dark {
                    p.c(Token::MutedForeground)
                } else {
                    foreground.opacity(0.6)
                })
                .when(on && !dark, |d| d.bg(p.c(Token::Background)).shadow_sm())
                .when(on && dark, |d| {
                    d.bg(p.c(Token::Input).opacity(0.3))
                        .border_color(p.c(Token::Input))
                })
                .when(!on, |d| d.hover(move |d| d.text_color(foreground)))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = this.settings.as_mut() {
                        set(&mut s.usage, value);
                    }
                    cx.notify();
                })),
        );
    }
    list
}

/// The five-cell strip under the cost summary.
fn summary_strip(stats: Option<&UsageStats>, p: &Palette, english: bool) -> AnyElement {
    let dash = || "—".to_string();
    let days = |n: u64| {
        if english && n == 1 {
            tr!(english, "usage.days_count_one", count = n)
        } else {
            tr!(english, "usage.days_count", count = n)
        }
    };
    let cells = [
        (
            trs!(english, "usage.total_token_count"),
            stats.map_or_else(dash, |s| format_compact(s.totals.metrics.tokens, english)),
        ),
        (
            trs!(english, "usage.peak_tokens"),
            stats.map_or_else(dash, |s| {
                format_compact(
                    s.days.iter().map(|d| d.metrics.tokens).max().unwrap_or(0),
                    english,
                )
            }),
        ),
        (
            trs!(english, "usage.longest_chat"),
            stats.map_or_else(dash, |s| {
                if s.longest_session_minutes <= 0.0 {
                    dash()
                } else {
                    tr!(
                        english,
                        "usage.minutes",
                        count = (s.longest_session_minutes.round() as u64).max(1)
                    )
                }
            }),
        ),
        (
            trs!(english, "usage.current_streak"),
            stats.map_or_else(dash, |s| days(s.current_streak)),
        ),
        (
            trs!(english, "usage.longest_streak"),
            stats.map_or_else(dash, |s| days(s.longest_streak)),
        ),
    ];
    let divider = p.c(Token::Border).opacity(0.7);
    div()
        .flex()
        .rounded(px(12.0))
        .overflow_hidden()
        .bg(p.c(Token::Muted).opacity(0.45))
        .children(cells.into_iter().enumerate().map(|(i, (label, value))| {
            div()
                .flex_1()
                .min_w_0()
                .px(px(12.0))
                .py(px(16.0))
                .when(i == 0, |d| d.pl(px(16.0)))
                .when(i == 4, |d| d.pr(px(16.0)))
                .when(i > 0, |d| d.border_l_1().border_color(divider))
                .flex()
                .flex_col()
                .items_center()
                .child(
                    ui::truncate(value)
                        .text_size(px(TEXT_XL))
                        .line_height(px(28.0))
                        .font_weight(FontWeight::SEMIBOLD),
                )
                .child(
                    ui::truncate(label)
                        .mt(px(6.0))
                        .text_size(px(TEXT_XS))
                        .line_height(px(16.0))
                        .muted(p),
                )
        }))
        .into_any_element()
}

fn trim_fraction(value: f64, digits: usize) -> String {
    let text = format!("{value:.digits$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}
fn grouped(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}
/// `Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 })`.
fn intl_compact(value: u64, english: bool) -> String {
    let v = value as f64;
    let steps: &[(f64, &str)] = if english {
        &[(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")]
    } else {
        &[(1e12, "万亿"), (1e8, "亿"), (1e4, "万")]
    };
    for (unit, suffix) in steps {
        if v >= *unit {
            return format!("{}{suffix}", trim_fraction(v / unit, 1));
        }
    }
    value.to_string()
}
/// `formatCompact` of `usage-settings.tsx`: the strip, the donut and the legend.
fn format_compact(value: u64, english: bool) -> String {
    let v = value as f64;
    if !english {
        if v >= 1e8 {
            return format!("{:.1} 亿", v / 1e8);
        }
        if v >= 1e4 {
            return format!("{:.*} 万", if v >= 1e6 { 0 } else { 1 }, v / 1e4);
        }
    }
    if v >= 1e9 {
        format!("{:.1}B", v / 1e9)
    } else if v >= 1e6 {
        format!("{:.*}M", if v >= 1e7 { 0 } else { 1 }, v / 1e6)
    } else if v >= 1e3 {
        format!("{:.*}K", if v >= 1e5 { 0 } else { 1 }, v / 1e3)
    } else {
        grouped(value)
    }
}
/// `Intl` USD: `US$18.42` in Chinese, `$18.42` in English, four places below a cent.
fn usd(value: f64, english: bool) -> String {
    let places = if value > 0.0 && value < 0.01 { 4 } else { 2 };
    let text = format!("{value:.places$}");
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, ""));
    let mut fraction = fraction.to_string();
    while fraction.len() > 2 && fraction.ends_with('0') {
        fraction.pop();
    }
    let whole = whole
        .parse::<u64>()
        .map_or_else(|_| whole.to_string(), grouped);
    format!("{}{whole}.{fraction}", if english { "$" } else { "US$" })
}
fn money(metrics: &UsageMetrics, english: bool) -> String {
    metrics
        .cost
        .map(|c| {
            format!(
                "{}{}",
                usd(c, english),
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
/// `9月10日` / `9/10`.
fn date_label(date: &str, english: bool) -> String {
    let mut parts = date
        .split('-')
        .skip(1)
        .filter_map(|p| p.parse::<u32>().ok());
    let (Some(month), Some(day)) = (parts.next(), parts.next()) else {
        return date.to_string();
    };
    if english {
        format!("{month}/{day}")
    } else {
        format!("{month}月{day}日")
    }
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
    /// Monday-first weeks, as Electron's grid.
    weeks: Vec<Vec<HeatCell>>,
}
/// One page of at most a year ending `back` days before the range's end; weekly values count
/// the whole calendar week even where it crosses the page boundary.
fn calendar(stats: &UsageStats, view: Activity, back: u64) -> Option<Calendar> {
    let start: NaiveDate = stats.from.parse().ok()?;
    let end: NaiveDate = stats.to.parse().ok()?;
    let to = end.checked_sub_days(Days::new(back))?.max(start);
    let from = to.checked_sub_days(Days::new(364))?.max(start);
    let first = from.checked_sub_days(Days::new(from.weekday().num_days_from_monday() as u64))?;
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
fn heatmap(
    calendar: Calendar,
    later: bool,
    p: &Palette,
    english: bool,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let n = calendar.weeks.len();
    let muted = p.c(Token::MutedForeground);
    // Month captions: the month of each week's first in-range day, printed where a month
    // begins and only when its columns are wide enough to hold the label (`captionFits`).
    let months: Vec<u32> = calendar
        .weeks
        .iter()
        .map(|w| w.iter().find(|c| c.in_range).unwrap_or(&w[0]).date.month())
        .collect();
    // `captionFits`: the width of "Dec" / "12月" against the columns the month spans, each
    // column as wide as the grid's `n × 14px` cap (at most the card's 704px) leaves it.
    let ruler = if english { 24.0 } else { 28.0 };
    let column = ((n as f32 * 14.0).min(704.0) - 12.0 - n as f32 * 2.0) / n.max(1) as f32;
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
            .get(((values.len() as f64 * q) as usize).min(values.len().saturating_sub(1)))
            .copied()
            .unwrap_or(0)
    });
    let level = |value: u64| {
        if value == 0 {
            0
        } else if value <= thresholds[0] {
            1
        } else if value <= thresholds[1] {
            2
        } else if value <= thresholds[2] {
            3
        } else {
            4
        }
    };
    let weekday = [
        Some("usage.weekday_mon"),
        None,
        Some("usage.weekday_wed"),
        None,
        Some("usage.weekday_fri"),
        None,
        Some("usage.weekday_sun"),
    ];
    // Week columns of square cells (the grid's `aspect-square` tracks), the weekday labels
    // stretched beside them so each label rides its row whatever width the columns get.
    let hover_ring = p.c(Token::Foreground).opacity(0.25);
    let caption = |text: Option<&'static str>| {
        div()
            .h(px(16.0))
            .flex_none()
            .text_size(px(TEXT_XS))
            .line_height(px(16.0))
            .whitespace_nowrap()
            .text_color(muted)
            .when_some(text, |d, t| d.child(t))
    };
    let mut labels = div()
        .w(px(12.0))
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(caption(None));
    for key in weekday {
        labels = labels.child(
            div()
                .flex_1()
                .pr(px(2.0))
                .flex()
                .justify_end()
                .text_size(px(TEXT_XS))
                .line_height(px(12.0))
                .text_color(muted)
                .when_some(key, |d, key| d.child(trs!(english, key))),
        );
    }
    let mut grid = div()
        .w_full()
        .max_w(px(n as f32 * 14.0))
        .flex()
        .gap(px(2.0))
        .child(labels);
    for (i, week) in calendar.weeks.iter().enumerate() {
        let month = months[i];
        let starts = i == 0 || months[i - 1] != month;
        let span = months[i..].iter().take_while(|m| **m == month).count();
        let text = (starts && span as f32 * (column + 2.0) - 2.0 >= ruler)
            .then(|| crate::workspace::static_text(english, &format!("usage.month_{month}")));
        let mut column = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(caption(text));
        for cell in week {
            if !cell.in_range {
                column = column.child(div().w_full().aspect_square());
                continue;
            }
            let color = match level(cell.value) {
                0 => p.c(Token::Muted).opacity(0.6),
                l => p.c(Token::Primary).opacity([0.0, 0.15, 0.3, 0.6, 1.0][l]),
            };
            let (date, value) = (cell.date, cell.value);
            column = column.child(
                div()
                    .id(SharedString::from(format!("usage-day-{date}")))
                    .w_full()
                    .aspect_square()
                    .rounded(px(3.0))
                    .border_1()
                    .border_color(transparent_black())
                    .bg(color)
                    .hover(move |d| d.border_color(hover_ring))
                    .tooltip(move |window, cx| {
                        let line = if value > 0 {
                            format!(
                                "{} {}",
                                format_compact(value, english),
                                trs!(english, "usage.tokens")
                            )
                        } else {
                            trs!(english, "usage.no_activity").to_string()
                        };
                        gpui_kit::component::tooltip::Tooltip::new(SharedString::from(format!(
                            "{}\n{line}",
                            date_label(&date.to_string(), english)
                        )))
                        .build(window, cx)
                    }),
            );
        }
        grid = grid.child(column);
    }
    let short = |d: NaiveDate| format!("{:02}/{:02}", d.month(), d.day());
    let page = |id: &'static str, glyph: &'static str, key: &'static str, step: i64| {
        ui::icon_button_xs(id, glyph, p)
            .tooltip(move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(trs!(english, key)).build(window, cx)
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(s) = this.settings.as_mut() {
                    s.usage.heat_days_back = if step > 0 {
                        s.usage.heat_days_back + 365
                    } else {
                        s.usage.heat_days_back.saturating_sub(365)
                    };
                }
                cx.notify();
            }))
    };
    let footer = div()
        .mt(px(16.0))
        .flex()
        .items_center()
        .justify_between()
        .text_size(px(TEXT_XS))
        .line_height(px(16.0))
        .text_color(muted)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(4.0))
                .when(calendar.earlier, |d| {
                    d.child(page("usage-earlier", "arrow-left01", "usage.earlier", 1))
                })
                .child(SharedString::from(short(calendar.from))),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(4.0))
                .child(SharedString::from(short(calendar.to)))
                .when(later, |d| {
                    d.child(page("usage-later", "arrow-right01", "usage.later", -1))
                }),
        );
    div()
        .flex()
        .flex_col()
        .child(grid)
        .child(footer)
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

/// d3's `curveMonotoneX` (what recharts' `type="monotone"` draws): Fritsch–Carlson tangents,
/// one cubic per segment, so a line never overshoots its points.
fn monotone(path: &mut PathBuilder, points: &[Point<Pixels>]) {
    let Some(first) = points.first() else { return };
    path.move_to(*first);
    if points.len() == 2 {
        path.line_to(points[1]);
        return;
    }
    let xy = |p: &Point<Pixels>| (f32::from(p.x), f32::from(p.y));
    let n = points.len();
    let slopes: Vec<f32> = points
        .windows(2)
        .map(|w| {
            let ((x0, y0), (x1, y1)) = (xy(&w[0]), xy(&w[1]));
            if x1 == x0 { 0.0 } else { (y1 - y0) / (x1 - x0) }
        })
        .collect();
    let mut tangents = vec![0.0f32; n];
    tangents[0] = slopes[0];
    tangents[n - 1] = slopes[n - 2];
    for i in 1..n - 1 {
        let (a, b) = (slopes[i - 1], slopes[i]);
        tangents[i] = if a * b <= 0.0 {
            0.0
        } else {
            let (h0, h1) = (
                xy(&points[i]).0 - xy(&points[i - 1]).0,
                xy(&points[i + 1]).0 - xy(&points[i]).0,
            );
            let p = (a * h1 + b * h0) / (h0 + h1);
            (a.signum()) * a.abs().min(b.abs()).min(0.5 * p.abs()) * 2.0
        };
    }
    for i in 0..n - 1 {
        let ((x0, y0), (x1, y1)) = (xy(&points[i]), xy(&points[i + 1]));
        let dx = (x1 - x0) / 3.0;
        path.cubic_bezier_to(
            points[i + 1],
            point(gpui_kit::px(x0 + dx), gpui_kit::px(y0 + dx * tangents[i])),
            point(
                gpui_kit::px(x1 - dx),
                gpui_kit::px(y1 - dx * tangents[i + 1]),
            ),
        );
    }
}

/// A "nice" ceiling for four steps above zero, as recharts' auto domain picks one.
fn nice_max(peak: f64) -> f64 {
    if peak <= 0.0 {
        return 1.0;
    }
    let raw = peak / 4.0;
    let magnitude = 10f64.powf(raw.log10().floor());
    let step = [1.0, 2.0, 2.5, 5.0, 10.0]
        .into_iter()
        .map(|f| f * magnitude)
        .find(|s| *s >= raw)
        .unwrap_or(10.0 * magnitude);
    step * 4.0
}

/// `TrendChart`: the top five models over the last 7 or 30 days, one smooth line each.
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
    let day_tokens = |days: &[UsageDay], date: &str| {
        days.iter()
            .find(|d| d.date == date)
            .map_or(0, |d| d.metrics.tokens)
    };
    let (labels, series): (Vec<String>, Vec<Vec<u64>>) = if stats.models.is_empty() {
        (
            vec![trs!(english, "usage.total_tokens").to_string()],
            vec![dates.iter().map(|d| day_tokens(&stats.days, d)).collect()],
        )
    } else {
        stats
            .models
            .iter()
            .take(5)
            .map(|m| {
                (
                    m.model.clone(),
                    dates.iter().map(|d| day_tokens(&m.days, d)).collect(),
                )
            })
            .unzip()
    };
    let peak = series.iter().flatten().copied().max().unwrap_or(0);
    let top = nice_max(peak as f64) as f32;
    let chart_colors = colors(p);
    let grid = p.c(Token::Border).opacity(0.55);
    let muted = p.c(Token::MutedForeground);

    let legend = div()
        .mb(px(16.0))
        .flex()
        .flex_wrap()
        .gap_x(px(20.0))
        .gap_y(px(8.0))
        .text_size(px(TEXT_XS))
        .line_height(px(16.0))
        .text_color(muted)
        .children(labels.iter().enumerate().map(|(i, label)| {
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .size(px(8.0))
                        .flex_none()
                        .rounded_full()
                        .bg(chart_colors[i % chart_colors.len()]),
                )
                .child(ui::truncate(label.clone()).max_w(px(192.0)))
        }));

    // recharts' margins: 8 top/left/right, the x axis's 30px band at the bottom.
    const LEFT: f32 = 8.0;
    const TOP: f32 = 8.0;
    const AXIS: f32 = 30.0;
    let count = dates.len();
    let line_series = series.clone();
    let line_colors = chart_colors.clone();
    let plot = canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let ox = f32::from(bounds.origin.x) + LEFT;
            let oy = f32::from(bounds.origin.y) + TOP;
            let w = (f32::from(bounds.size.width) - 2.0 * LEFT).max(1.0);
            let h = (f32::from(bounds.size.height) - TOP - AXIS).max(1.0);
            for step in 0..=4 {
                let y = gpui_kit::px(oy + h * step as f32 / 4.0);
                let mut path = PathBuilder::stroke(gpui_kit::px(1.0))
                    .dash_array(&[gpui_kit::px(3.0), gpui_kit::px(4.0)]);
                path.move_to(point(gpui_kit::px(ox), y));
                path.line_to(point(gpui_kit::px(ox + w), y));
                if let Ok(path) = path.build() {
                    window.paint_path(path, grid);
                }
            }
            for (j, values) in line_series.iter().enumerate() {
                let points: Vec<_> = values
                    .iter()
                    .enumerate()
                    .map(|(i, value)| {
                        let x = if count > 1 {
                            ox + w * i as f32 / (count - 1) as f32
                        } else {
                            ox + w / 2.0
                        };
                        point(
                            gpui_kit::px(x),
                            gpui_kit::px(oy + h * (1.0 - *value as f32 / top)),
                        )
                    })
                    .collect();
                let mut path = PathBuilder::stroke(gpui_kit::px(2.0));
                monotone(&mut path, &points);
                if let Ok(path) = path.build() {
                    window.paint_path(path, line_colors[j % line_colors.len()]);
                }
            }
        },
    )
    .size_full();

    // Tick labels, every day up to two weeks, then every fifth.
    let every = if count > 14 { 5 } else { 1 };
    let ticks = div()
        .absolute()
        .left(px(LEFT))
        .right(px(LEFT))
        .bottom(px(0.0))
        .h(px(AXIS))
        .children(
            dates
                .iter()
                .enumerate()
                .filter(|(i, _)| i % every == 0)
                .map(|(i, date)| {
                    let frac = if count > 1 {
                        i as f32 / (count - 1) as f32
                    } else {
                        0.5
                    };
                    let label = div()
                        .absolute()
                        .top(px(9.0))
                        .w(px(72.0))
                        .text_size(px(TEXT_XS))
                        .line_height(px(16.0))
                        .text_color(muted)
                        .whitespace_nowrap()
                        .child(SharedString::from(date_label(date, english)));
                    // The ends hug the plot instead of hanging past the card.
                    if i == 0 && count > 1 {
                        label.left(px(-LEFT)).text_left()
                    } else if i + 1 == count && count > 1 {
                        label.right(px(-LEFT)).text_right()
                    } else {
                        label.left(relative(frac)).ml(px(-36.0)).text_center()
                    }
                }),
        );

    let tips: Vec<_> = dates
        .iter()
        .enumerate()
        .map(|(i, date)| {
            let mut tip = date_label(date, english);
            for (j, label) in labels.iter().enumerate() {
                tip.push_str(&format!(
                    "\n{label}{}{}",
                    if english { ": " } else { "：" },
                    format_compact(series[j][i], english)
                ));
            }
            tip
        })
        .collect();
    let hits = div()
        .absolute()
        .top(px(0.0))
        .left(px(0.0))
        .size_full()
        .flex()
        .children(tips.into_iter().enumerate().map(|(i, tip)| {
            div()
                .id(SharedString::from(format!("usage-tip-{i}")))
                .flex_1()
                .h_full()
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(SharedString::from(tip.clone()))
                        .build(window, cx)
                })
        }));

    div()
        .flex()
        .flex_col()
        .child(legend)
        .child(
            div()
                .h(px(256.0))
                .w_full()
                .relative()
                .child(plot)
                .child(ticks)
                .child(hits),
        )
        .into_any_element()
}

/// `ModelUsage`: the donut with the total in its hole, and the top five beside it.
fn model_usage(stats: &UsageStats, p: &Palette, english: bool) -> AnyElement {
    let mut items: Vec<(String, String, u64)> = stats
        .models
        .iter()
        .take(5)
        .map(|m| {
            (
                m.model.clone(),
                m.provider_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&m.provider)
                    .to_string(),
                m.metrics.tokens,
            )
        })
        .collect();
    let shown = stats
        .models
        .iter()
        .fold(0u64, |sum, m| sum.saturating_add(m.metrics.tokens));
    let other = stats.totals.metrics.tokens.saturating_sub(shown);
    if other > 0 {
        items.push((trs!(english, "usage.other").into(), String::new(), other));
    }
    let total = items
        .iter()
        .fold(0u64, |sum, (_, _, n)| sum.saturating_add(*n))
        .max(1);
    let chart_colors = colors(p);
    let segments: Vec<(f32, Hsla)> = items
        .iter()
        .enumerate()
        .map(|(i, (_, _, n))| {
            (
                *n as f32 / total as f32,
                chart_colors[i % chart_colors.len()],
            )
        })
        .collect();
    // recharts `<Pie innerRadius="58%" outerRadius="82%" paddingAngle={1}>`: from three
    // o'clock, counter-clockwise, one degree between slices.
    let ring = canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let c = bounds.center();
            let half = f32::from(bounds.size.width.min(bounds.size.height)) / 2.0;
            let (outer, inner) = (half * 0.82, half * 0.58);
            let pad = if segments.iter().filter(|(f, _)| *f > 0.0).count() > 1 {
                1.0f32.to_radians()
            } else {
                0.0
            };
            let available = std::f32::consts::TAU - pad * segments.len() as f32;
            let mut start = 0.0f32;
            for (fraction, color) in &segments {
                if *fraction <= 0.0 {
                    continue;
                }
                let sweep = available * fraction;
                let steps = ((sweep * 40.0).ceil() as usize).max(2);
                let at = |r: f32, a: f32| {
                    point(
                        c.x + gpui_kit::px(r * a.cos()),
                        c.y - gpui_kit::px(r * a.sin()),
                    )
                };
                let mut points = Vec::with_capacity(2 * steps + 2);
                for i in 0..=steps {
                    points.push(at(outer, start + sweep * i as f32 / steps as f32));
                }
                for i in (0..=steps).rev() {
                    points.push(at(inner, start + sweep * i as f32 / steps as f32));
                }
                let mut path = PathBuilder::fill();
                path.add_polygon(&points, true);
                if let Ok(path) = path.build() {
                    window.paint_path(path, *color);
                }
                start += sweep + pad;
            }
        },
    )
    .size_full();
    let donut = div()
        .size(px(256.0))
        .flex_none()
        .relative()
        .child(ring)
        .child(
            div()
                .absolute()
                .top(px(0.0))
                .left(px(0.0))
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_size(px(TEXT_XL))
                        .line_height(px(28.0))
                        .font_weight(FontWeight::BOLD)
                        .child(SharedString::from(format_compact(
                            stats.totals.metrics.tokens,
                            english,
                        ))),
                )
                .child(
                    div()
                        .text_size(px(TEXT_XS))
                        .line_height(px(16.0))
                        .muted(p)
                        .child(trs!(english, "usage.tokens")),
                ),
        );
    let tokens_word = trs!(english, "usage.tokens");
    let legend = div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(12.0))
        .children(
            items
                .into_iter()
                .enumerate()
                .map(|(i, (label, provider, n))| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(12.0))
                        .text_size(px(TEXT_SM))
                        .line_height(px(20.0))
                        .child(
                            div()
                                .size(px(10.0))
                                .flex_none()
                                .rounded_full()
                                .bg(chart_colors[i % chart_colors.len()]),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(ui::truncate(label))
                                .when(!provider.is_empty(), |d| {
                                    d.child(
                                        ui::truncate(provider)
                                            .text_size(px(TEXT_XS))
                                            .line_height(px(16.0))
                                            .muted(p),
                                    )
                                }),
                        )
                        .child(div().flex_none().muted(p).child(SharedString::from(format!(
                            "{} {tokens_word}",
                            format_compact(n, english)
                        ))))
                        .child(
                            div()
                                .w(px(48.0))
                                .flex_none()
                                .flex()
                                .justify_end()
                                .muted(p)
                                .child(SharedString::from(format!(
                                    "{}%",
                                    (n as f64 / total as f64 * 100.0).round()
                                ))),
                        )
                }),
        );
    panel(p, 0.35)
        .child(
            div()
                .mb(px(16.0))
                .text_size(px(TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .child(trs!(english, "usage.model_usage")),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(32.0))
                .child(donut)
                .child(legend),
        )
        .into_any_element()
}

/// Electron's mock `USAGE`, with each model's share spread over the days so the trend has
/// lines to draw.
fn sample_stats(project: Option<String>) -> UsageStats {
    let metrics =
        |input, output, cache_read, cache_write, tokens, cost, requests, tool_calls| UsageMetrics {
            input,
            output,
            cache_read,
            cache_write,
            tokens,
            requests,
            tool_calls,
            cost: Some(cost),
            unpriced_requests: 0,
        };
    let days: Vec<UsageDay> = [
        (
            "2026-08-18",
            metrics(64_200, 6_100, 31_200, 2_100, 101_500, 0.62, 14, 41),
        ),
        (
            "2026-08-20",
            metrics(92_400, 9_800, 44_100, 3_200, 146_300, 0.94, 19, 63),
        ),
        (
            "2026-08-25",
            metrics(121_800, 12_400, 58_300, 4_100, 192_500, 1.21, 26, 82),
        ),
        (
            "2026-08-28",
            metrics(88_100, 8_900, 41_700, 2_900, 138_700, 0.88, 18, 52),
        ),
        (
            "2026-09-02",
            metrics(143_600, 15_200, 71_400, 5_300, 230_200, 1.46, 31, 104),
        ),
        (
            "2026-09-05",
            metrics(96_300, 10_100, 46_900, 3_400, 153_300, 0.98, 21, 66),
        ),
        (
            "2026-09-08",
            metrics(168_900, 17_800, 84_200, 6_100, 270_900, 1.72, 36, 128),
        ),
        (
            "2026-09-11",
            metrics(132_400, 13_900, 65_800, 4_700, 212_100, 1.35, 29, 97),
        ),
        (
            "2026-09-14",
            metrics(176_200, 19_400, 89_600, 6_800, 285_200, 1.84, 38, 141),
        ),
    ]
    .into_iter()
    .map(|(date, metrics)| UsageDay {
        date: date.into(),
        metrics,
    })
    .collect();
    let totals = metrics(
        1_842_300, 184_200, 934_000, 62_400, 2_960_900, 18.42, 412, 1_284,
    );
    let model = |provider: &str, model: &str, share: f64, metrics: UsageMetrics| UsageModel {
        provider: provider.into(),
        provider_name: None,
        model: model.into(),
        metrics,
        days: days
            .iter()
            .enumerate()
            .map(|(i, d)| UsageDay {
                date: d.date.clone(),
                metrics: UsageMetrics {
                    // A little wobble so the three lines do not run parallel.
                    tokens: (d.metrics.tokens as f64
                        * share
                        * (0.8 + 0.4 * ((i * 7) % 5) as f64 / 4.0))
                        as u64,
                    ..Default::default()
                },
            })
            .collect(),
    };
    let models = vec![
        model(
            "fastvibe",
            "claude-fable-5-1",
            0.62,
            metrics(
                1_120_400, 112_800, 612_000, 38_200, 1_845_200, 11.24, 248, 802,
            ),
        ),
        model(
            "fastvibe",
            "gpt-6.1-sol",
            0.27,
            metrics(512_900, 51_200, 246_800, 16_900, 810_900, 5.18, 112, 358),
        ),
        model(
            "deepseek",
            "deepseek-v4-pro",
            0.10,
            metrics(209_000, 20_200, 75_200, 7_300, 304_800, 2.0, 52, 124),
        ),
    ];
    UsageStats {
        range: UsageRange::Month,
        timezone: "UTC".into(),
        from: "2026-08-16".into(),
        to: "2026-09-15".into(),
        totals: UsageTotals {
            metrics: totals.clone(),
            active_days: 21,
        },
        days,
        models,
        conversations: vec![UsageConversation {
            session_id: "sample".into(),
            thread_id: Some("sample".into()),
            title: Some("fastvibe".into()),
            project: Some(project.unwrap_or_else(|| "fastvibe".into())),
            metrics: totals,
        }],
        sessions: 37,
        longest_session_minutes: 19.0,
        current_streak: 1,
        longest_streak: 3,
        invalid_timestamps: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::{Activity, calendar, format_compact, intl_compact, merge, money, usd};
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
        // Weeks start on Monday; the page starts on Tuesday 2025-10-28, so Monday's 7 sits
        // just outside it but still belongs to the first week's total.
        let mut stats = stats();
        stats.to = "2026-10-27".into();
        stats.days[0].date = "2025-10-27".into();
        stats.days[1].date = "2025-10-29".into();
        let weekly = calendar(&stats, Activity::Weekly, 0).unwrap();
        assert_eq!(weekly.from.to_string(), "2025-10-28");
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
    fn numbers_read_as_electron_formats_them() {
        assert_eq!(intl_compact(1_842_300, false), "184.2万");
        assert_eq!(intl_compact(2_960_900, false), "296.1万");
        assert_eq!(intl_compact(180_000, false), "18万");
        assert_eq!(intl_compact(1_842_300, true), "1.8M");
        assert_eq!(intl_compact(184_200, true), "184.2K");
        assert_eq!(format_compact(2_960_900, false), "296 万");
        assert_eq!(format_compact(285_200, false), "28.5 万");
        assert_eq!(format_compact(2_960_900, true), "3.0M");
        assert_eq!(usd(18.42, false), "US$18.42");
        assert_eq!(usd(1234.5, true), "$1,234.50");
        assert_eq!(usd(0.0012, true), "$0.0012");
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
