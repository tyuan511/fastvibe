//! Native stream framing. Each binary SCTP message begins with a native control tag.
//! DATA bytes are newline-delimited fv-protocol JSON, not Electron envelopes/fragments.
//! SCTP is required reliable + ordered. The stream adapter bounds partial JSON lines.
use crate::{Error, Result};
use fv_protocol::official::{RTC_FRAGMENT_BYTES, RTC_MAX_FRAME_BYTES};

pub const DATA: u8 = 0;
pub const PING: u8 = 1;
pub const PONG: u8 = 2;
pub const CLOSE: u8 = 3;

pub fn fragment(data: &[u8]) -> impl Iterator<Item = Vec<u8>> + '_ {
    data.chunks(RTC_FRAGMENT_BYTES - 1).map(|chunk| {
        let mut out = Vec::with_capacity(chunk.len() + 1);
        out.push(DATA);
        out.extend_from_slice(chunk);
        out
    })
}

#[derive(Default)]
pub struct LineLimit {
    bytes: usize,
}
impl LineLimit {
    /// Enforce one bounded line even when a peer never terminates it. No extra copies.
    pub fn check(&mut self, data: &[u8]) -> Result<()> {
        for part in data.split_inclusive(|b| *b == b'\n') {
            self.bytes += part.len();
            if self.bytes > RTC_MAX_FRAME_BYTES {
                return Err(Error::Protocol("frame too large"));
            }
            if part.last() == Some(&b'\n') {
                self.bytes = 0;
            }
        }
        Ok(())
    }
}

pub enum Incoming<'a> {
    Data(&'a [u8]),
    Ping,
    Pong,
    Close,
}
pub fn parse(message: &[u8]) -> Result<Incoming<'_>> {
    if message.len() > RTC_FRAGMENT_BYTES {
        return Err(Error::Protocol("fragment too large"));
    }
    match message {
        [DATA, bytes @ ..] if !bytes.is_empty() => Ok(Incoming::Data(bytes)),
        [PING] => Ok(Incoming::Ping),
        [PONG] => Ok(Incoming::Pong),
        [CLOSE] => Ok(Incoming::Close),
        _ => Err(Error::Protocol("invalid fragment")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_stream_fragments_roundtrip_without_old_protocol_headers() {
        let data = b"{\"id\":1,\"method\":\"initialize\"}\n".repeat(2000);
        let mut out = Vec::new();
        for fragment in fragment(&data) {
            assert!(fragment.len() <= RTC_FRAGMENT_BYTES);
            let Incoming::Data(bytes) = parse(&fragment).unwrap() else {
                panic!()
            };
            out.extend_from_slice(bytes);
        }
        assert_eq!(out, data);
        for bad in [vec![], vec![DATA], vec![PING, 1], vec![0x20]] {
            assert!(parse(&bad).is_err());
        }
        let mut limit = LineLimit::default();
        assert!(limit.check(&vec![b'x'; RTC_MAX_FRAME_BYTES]).is_ok());
        assert!(limit.check(b"x").is_err());
        let mut limit = LineLimit::default();
        for _ in 0..10 {
            limit.check(b"{}\n").unwrap();
        }
    }
}
