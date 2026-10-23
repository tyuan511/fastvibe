//! Colours as the theme tokens use them: sRGB with alpha.
//!
//! The TypeScript tokens are CSS strings (`#rrggbb`, `rgb(r g b / a)`, `oklch(l c h)`,
//! `color-mix(in oklab, X p%, transparent)`). `parse` reads exactly those four shapes so
//! the exported snapshot can be compared against what `buildTokens` here produces.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// 0.0 transparent .. 1.0 opaque.
    pub a: f32,
}

impl Color {
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 1.0 }
    }

    pub fn with_alpha(self, a: f32) -> Self {
        Self {
            a: (self.a * a).clamp(0.0, 1.0),
            ..self
        }
    }

    /// `color-mix(in oklab, self p%, transparent)`.
    ///
    /// Mixing with transparent in a premultiplied space leaves the colour untouched and
    /// scales the alpha, so this is exact rather than an approximation.
    pub fn mix_with_transparent(self, percent: f32) -> Self {
        self.with_alpha(percent / 100.0)
    }

    /// Whether `other` is the same colour within `tolerance` per 8-bit channel and in alpha.
    pub fn close_to(&self, other: &Self, tolerance: u8) -> bool {
        let d = |a: u8, b: u8| a.abs_diff(b) <= tolerance;
        d(self.r, other.r)
            && d(self.g, other.g)
            && d(self.b, other.b)
            && (self.a - other.a).abs() <= f32::from(tolerance) / 255.0 + 1e-4
    }
}

impl fmt::Display for Color {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.a >= 1.0 {
            write!(f, "#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
        } else {
            write!(f, "rgb({} {} {} / {})", self.r, self.g, self.b, self.a)
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct ParseError(pub String);

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "cannot read colour {:?}", self.0)
    }
}

impl std::error::Error for ParseError {}

pub fn parse(input: &str) -> Result<Color, ParseError> {
    let s = input.trim();
    let bad = || ParseError(input.to_string());
    if let Some(hex) = s.strip_prefix('#') {
        return parse_hex(hex).ok_or_else(bad);
    }
    if let Some(args) = function_args(s, "rgb") {
        return parse_rgb(args).ok_or_else(bad);
    }
    if let Some(args) = function_args(s, "oklch") {
        return parse_oklch(args).ok_or_else(bad);
    }
    if let Some(args) = function_args(s, "color-mix") {
        return parse_mix(args).ok_or_else(bad);
    }
    Err(bad())
}

fn function_args<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    s.strip_prefix(name)?
        .trim_start()
        .strip_prefix('(')?
        .strip_suffix(')')
}

fn parse_hex(hex: &str) -> Option<Color> {
    let byte = |i: usize| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok();
    match hex.len() {
        6 => Some(Color::rgb(byte(0)?, byte(2)?, byte(4)?)),
        8 => Some(Color {
            a: f32::from(byte(6)?) / 255.0,
            ..Color::rgb(byte(0)?, byte(2)?, byte(4)?)
        }),
        _ => None,
    }
}

fn parse_alpha(token: &str) -> Option<f32> {
    match token.strip_suffix('%') {
        Some(p) => Some(p.parse::<f32>().ok()? / 100.0),
        None => token.parse().ok(),
    }
}

fn split_alpha(args: &str) -> (&str, Option<&str>) {
    match args.split_once('/') {
        Some((body, alpha)) => (body.trim(), Some(alpha.trim())),
        None => (args.trim(), None),
    }
}

fn parse_rgb(args: &str) -> Option<Color> {
    let (body, alpha) = split_alpha(args);
    let mut parts = body.split_whitespace();
    let mut channel = || {
        parts
            .next()?
            .parse::<f32>()
            .ok()
            .map(|v| v.round().clamp(0.0, 255.0) as u8)
    };
    let (r, g, b) = (channel()?, channel()?, channel()?);
    let a = alpha.map(parse_alpha).unwrap_or(Some(1.0))?;
    Some(Color { r, g, b, a })
}

fn parse_oklch(args: &str) -> Option<Color> {
    let (body, alpha) = split_alpha(args);
    let mut parts = body.split_whitespace();
    let l: f32 = parts.next()?.parse().ok()?;
    let c: f32 = parts.next()?.parse().ok()?;
    let h: f32 = parts.next()?.trim_end_matches("deg").parse().ok()?;
    let a = alpha.map(parse_alpha).unwrap_or(Some(1.0))?;
    let (r, g, b) = oklch_to_srgb(l, c, h);
    Some(Color { r, g, b, a })
}

fn oklch_to_srgb(l: f32, c: f32, h_deg: f32) -> (u8, u8, u8) {
    let h = h_deg.to_radians();
    let (a, b) = (c * h.cos(), c * h.sin());
    let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l3, m3, s3) = (l_.powi(3), m_.powi(3), s_.powi(3));
    let lin = [
        4.076_741_7 * l3 - 3.307_711_6 * m3 + 0.230_969_94 * s3,
        -1.268_438 * l3 + 2.609_757_4 * m3 - 0.341_319_4 * s3,
        -0.004_196_086_3 * l3 - 0.703_418_6 * m3 + 1.707_614_7 * s3,
    ];
    let encode = |v: f32| {
        let v = v.clamp(0.0, 1.0);
        let g = if v <= 0.003_130_8 {
            12.92 * v
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        };
        (g * 255.0).round() as u8
    };
    (encode(lin[0]), encode(lin[1]), encode(lin[2]))
}

/// `in oklab|srgb, <colour> <p>%, transparent` — against transparent both spaces give the same result.
fn parse_mix(args: &str) -> Option<Color> {
    let args = args.trim();
    let rest = args
        .strip_prefix("in oklab,")
        .or_else(|| args.strip_prefix("in srgb,"))?
        .trim();
    let (mixed, tail) = rest.rsplit_once(',')?;
    if tail.trim() != "transparent" {
        return None;
    }
    let (color, percent) = mixed.trim().rsplit_once(' ')?;
    let percent: f32 = percent.strip_suffix('%')?.parse().ok()?;
    Some(parse(color.trim()).ok()?.mix_with_transparent(percent))
}

impl<'de> serde::Deserialize<'de> for Color {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        parse(&s).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_and_rgb_agree() {
        assert_eq!(parse("#0d1117").unwrap(), Color::rgb(13, 17, 23));
        assert_eq!(
            parse("rgb(255 255 255 / 0.055)").unwrap(),
            Color {
                r: 255,
                g: 255,
                b: 255,
                a: 0.055
            }
        );
    }

    #[test]
    fn oklch_grey_is_near_white() {
        let c = parse("oklch(0.985 0 0)").unwrap();
        assert!(c.r == c.g && c.g == c.b && c.r > 245);
    }

    #[test]
    fn mix_with_transparent_scales_alpha() {
        let c = parse("color-mix(in oklab, #e6edf3 8%, transparent)").unwrap();
        assert_eq!((c.r, c.g, c.b), (0xe6, 0xed, 0xf3));
        assert!((c.a - 0.08).abs() < 1e-6);
    }

    #[test]
    fn rejects_unknown_shapes() {
        assert!(parse("hsl(0 0% 0%)").is_err());
        assert!(parse("color-mix(in srgb, #fff 50%, #000)").is_err());
        assert!(parse("color-mix(in srgb, #ffffff 10%, transparent)").is_ok());
    }
}
