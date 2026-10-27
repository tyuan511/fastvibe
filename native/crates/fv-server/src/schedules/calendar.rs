//! Wall-clock recurrence, including a single first occurrence in a repeated DST minute and
//! the first valid minute after a spring-forward gap. No interval drift after sleep.
use chrono::{DateTime, Datelike, Days, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use fv_protocol::schedules::ScheduleRule;

pub fn validate(rule: &ScheduleRule) -> Result<(), String> {
    match rule {
        ScheduleRule::Once { at } => {
            DateTime::parse_from_rfc3339(at)
                .map_err(|_| "一次性执行时间必须包含明确的时区。".to_string())?;
        }
        ScheduleRule::Daily { time, time_zone }
        | ScheduleRule::Weekly {
            time, time_zone, ..
        } => {
            clock(time)?;
            time_zone
                .parse::<Tz>()
                .map_err(|_| "请选择有效的 IANA 时区。".to_string())?;
        }
    }
    if let ScheduleRule::Weekly { days, .. } = rule
        && (days.is_empty()
            || days.len() > 7
            || days.iter().any(|d| *d > 6)
            || days.iter().collect::<std::collections::HashSet<_>>().len() != days.len())
    {
        return Err("每周任务需要选择不重复的星期，星期日为 0、星期六为 6。".into());
    }
    Ok(())
}
fn clock(time: &str) -> Result<NaiveTime, String> {
    if time.len() != 5 || time.as_bytes()[2] != b':' {
        return Err("时间请填写 HH:MM。".into());
    }
    NaiveTime::parse_from_str(time, "%H:%M").map_err(|_| "时间请填写有效的 HH:MM。".into())
}
fn wall(zone: Tz, date: NaiveDate, time: NaiveTime) -> Option<i64> {
    let mut local = date.and_time(time);
    for _ in 0..1440 {
        if local.date() != date {
            return None;
        }
        match zone.from_local_datetime(&local) {
            LocalResult::Single(dt) => return Some(dt.timestamp_millis()),
            LocalResult::Ambiguous(a, b) => return Some(a.min(b).timestamp_millis()),
            LocalResult::None => local = local.checked_add_signed(chrono::Duration::minutes(1))?,
        }
    }
    None
}
/// Next strictly after now, or latest at/before now. At most one occurrence per local date.
fn occurrence(rule: &ScheduleRule, now: i64, future: bool) -> Result<Option<i64>, String> {
    validate(rule)?;
    if let ScheduleRule::Once { at } = rule {
        let at = DateTime::parse_from_rfc3339(at)
            .map_err(|e| e.to_string())?
            .timestamp_millis();
        return Ok(((at > now) == future).then_some(at));
    }
    let (time, zone, days) = match rule {
        ScheduleRule::Daily { time, time_zone } => (time, time_zone, None),
        ScheduleRule::Weekly {
            time,
            time_zone,
            days,
        } => (time, time_zone, Some(days)),
        _ => unreachable!(),
    };
    let zone = zone.parse::<Tz>().map_err(|e| e.to_string())?;
    let time = clock(time)?;
    let date = DateTime::<Utc>::from_timestamp_millis(now)
        .ok_or("执行时间超出支持范围。")?
        .with_timezone(&zone)
        .date_naive();
    for offset in 0..=15 {
        let date = if future {
            date.checked_add_days(Days::new(offset))
        } else {
            date.checked_sub_days(Days::new(offset))
        }
        .ok_or("执行日期超出支持范围。")?;
        if days.is_some_and(|days| !days.contains(&date.weekday().num_days_from_sunday())) {
            continue;
        }
        if let Some(at) = wall(zone, date, time)
            && (at > now) == future
        {
            return Ok(Some(at));
        }
    }
    Err("无法计算指定时区的执行时间。".into())
}
pub fn next(rule: &ScheduleRule, now: i64) -> Result<Option<i64>, String> {
    occurrence(rule, now, true)
}
pub fn latest(rule: &ScheduleRule, now: i64) -> Result<Option<i64>, String> {
    occurrence(rule, now, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(s: &str) -> i64 {
        DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }
    #[test]
    fn dst_gaps_shift_forward_and_repeated_minutes_run_only_once() {
        let r = ScheduleRule::Daily {
            time: "02:30".into(),
            time_zone: "America/New_York".into(),
        };
        assert_eq!(
            next(&r, at("2026-03-08T00:00:00-05:00")).unwrap(),
            Some(at("2026-03-08T03:00:00-04:00"))
        );
        let r = ScheduleRule::Daily {
            time: "01:30".into(),
            time_zone: "America/New_York".into(),
        };
        assert_eq!(
            next(&r, at("2026-11-01T00:00:00-04:00")).unwrap(),
            Some(at("2026-11-01T01:30:00-04:00"))
        );
        assert_eq!(
            next(&r, at("2026-11-01T01:45:00-04:00")).unwrap(),
            Some(at("2026-11-02T01:30:00-05:00"))
        );
    }
    #[test]
    fn weekly_and_latest_occurrence_use_local_calendar_and_explicit_timezone() {
        let r = ScheduleRule::Weekly {
            time: "09:00".into(),
            time_zone: "Asia/Shanghai".into(),
            days: vec![1],
        };
        assert_eq!(
            next(&r, at("2026-10-26T09:00:00+08:00")).unwrap(),
            Some(at("2026-11-02T09:00:00+08:00"))
        );
        assert_eq!(
            latest(&r, at("2026-10-27T01:00:00+08:00")).unwrap(),
            Some(at("2026-10-26T09:00:00+08:00"))
        );
        assert!(
            validate(&ScheduleRule::Weekly {
                time: "25:00".into(),
                time_zone: "UTC".into(),
                days: vec![]
            })
            .is_err()
        );
        assert!(
            validate(&ScheduleRule::Once {
                at: "2026-10-27T09:00:00".into()
            })
            .is_err()
        );
    }
}
