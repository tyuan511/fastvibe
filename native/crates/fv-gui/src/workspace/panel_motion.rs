//! The desktop shell uses the Electron CSS transition: 280ms cubic-bezier(.22,1,.36,1).
//! Keep the content at its resting width and animate its clipping column, so rows never squash.
use std::time::{Duration, Instant};

const DURATION: Duration = Duration::from_millis(280);

#[derive(Default)]
pub(super) struct PanelMotion {
    initialized: bool,
    from: f32,
    target: f32,
    started: Option<Instant>,
    pub width: f32,
}

impl PanelMotion {
    pub fn update(&mut self, target: f32, immediate: bool, now: Instant) -> bool {
        if !self.initialized || immediate {
            self.initialized = true;
            self.from = target;
            self.target = target;
            self.width = target;
            self.started = None;
            return false;
        }
        self.sample(now);
        if (self.target - target).abs() > 0.01 {
            self.from = self.width;
            self.target = target;
            self.started = Some(now);
        }
        self.started.is_some()
    }

    fn sample(&mut self, now: Instant) {
        let Some(started) = self.started else { return };
        let t = now.saturating_duration_since(started).as_secs_f32() / DURATION.as_secs_f32();
        if t >= 1.0 {
            self.width = self.target;
            self.started = None;
        } else {
            self.width = self.from + (self.target - self.from) * ease(t);
        }
    }
}

// Invert the Bezier's x coordinate; using t directly as the curve parameter changes its timing.
fn ease(x: f32) -> f32 {
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..18 {
        let t = (lo + hi) * 0.5;
        let u = 1.0 - t;
        let at = 3.0 * u * u * t * 0.22 + 3.0 * u * t * t * 0.36 + t * t * t;
        if at < x {
            lo = t;
        } else {
            hi = t;
        }
    }
    let u = 1.0 - (lo + hi) * 0.5;
    1.0 - u * u * u
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collapse_reverses_from_visible_width_and_keeps_the_deadline() {
        let now = Instant::now();
        let mut motion = PanelMotion::default();
        assert!(!motion.update(288.0, false, now));
        assert!(motion.update(0.0, false, now));
        motion.update(0.0, false, now + Duration::from_millis(70));
        let interrupted = motion.width;
        assert!(interrupted > 0.0 && interrupted < 288.0);
        motion.update(288.0, false, now + Duration::from_millis(70));
        assert_eq!(motion.width, interrupted);
        assert!(!motion.update(288.0, false, now + Duration::from_millis(350)));
        assert_eq!(motion.width, 288.0);
    }
    #[test]
    fn live_drag_is_immediate_and_does_not_leave_an_animation_running() {
        let now = Instant::now();
        let mut motion = PanelMotion::default();
        motion.update(380.0, false, now);
        motion.update(0.0, false, now);
        assert!(!motion.update(450.0, true, now));
        assert_eq!(motion.width, 450.0);
    }
    #[test]
    fn css_curve_is_monotonic_without_overshoot() {
        let mut last = 0.0;
        for i in 0..=100 {
            let value = ease(i as f32 / 100.0);
            assert!(value >= last && value <= 1.0);
            last = value;
        }
        assert!((ease(0.5) - 0.9614).abs() < 0.002);
    }
}
