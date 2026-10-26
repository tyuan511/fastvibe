//! Decode each stream independently before merging it. A UTF-8 character split between reads
//! must not turn into replacement characters or get joined to bytes from the other stream.
use std::collections::VecDeque;

const HALF: usize = 512 * 1024;

#[derive(Default)]
pub(super) struct Collected {
    head: String,
    tail: VecDeque<String>,
    tail_bytes: usize,
    dropped: usize,
    sealed: bool,
}

impl Collected {
    pub fn push(&mut self, mut text: &str) {
        if !self.sealed && self.head.len() < HALF {
            let mut take = (HALF - self.head.len()).min(text.len());
            while !text.is_char_boundary(take) {
                take -= 1;
            }
            self.head.push_str(&text[..take]);
            text = &text[take..];
        }
        if !text.is_empty() {
            self.sealed = true;
            self.tail.push_back(text.into());
            self.tail_bytes += text.len();
        }
        while self.tail_bytes > HALF {
            let mut first = self.tail.pop_front().expect("buffer exceeds its bound");
            let mut remove = (self.tail_bytes - HALF).min(first.len());
            while !first.is_char_boundary(remove) {
                remove += 1;
            }
            self.tail_bytes -= remove;
            self.dropped += remove;
            first.drain(..remove);
            if !first.is_empty() {
                self.tail.push_front(first);
            }
        }
    }

    pub fn take(&mut self) -> String {
        let mut text = std::mem::take(&mut self.head);
        if self.dropped > 0 {
            text.push_str(&format!("\n[… {} bytes dropped …]\n", self.dropped));
        }
        for tail in self.tail.drain(..) {
            text.push_str(&tail);
        }
        self.tail_bytes = 0;
        self.dropped = 0;
        self.sealed = false;
        text
    }
}

#[derive(Default)]
pub(super) struct Decoder(Vec<u8>);
impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.0.extend_from_slice(bytes);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.0) {
                Ok(text) => {
                    output.push_str(text);
                    self.0.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    output.push_str(std::str::from_utf8(&self.0[..valid]).expect("UTF-8 prefix"));
                    self.0.drain(..valid);
                    match error.error_len() {
                        None => break,
                        Some(n) => {
                            self.0.drain(..n);
                            output.push('\u{fffd}');
                        }
                    }
                }
            }
        }
        output
    }
    pub fn finish(self) -> String {
        String::from_utf8_lossy(&self.0).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_character_at_the_head_limit_does_not_get_reordered_with_later_output() {
        let mut out = Collected::default();
        out.push(&"x".repeat(HALF - 1));
        out.push("中");
        out.push("Z");
        assert!(out.take().ends_with("中Z"));
        assert_eq!(out.take(), "");
    }
}
