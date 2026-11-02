use crate::*;
use flate2::read::DeflateDecoder;
use std::io::Read;

#[derive(Debug, Clone, PartialEq)]
pub enum FrameError {
    EmptyMessage,
    UnknownHeaderBits,
    FragmentKindChanged,
    FrameTooLarge,
    CloseMessageTooShort,
    BadCompressedFrame,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::EmptyMessage => "empty message",
            Self::UnknownHeaderBits => "unknown header bits",
            Self::FragmentKindChanged => "fragment kind changed mid-frame",
            Self::FrameTooLarge => "frame too large",
            Self::CloseMessageTooShort => "close message too short",
            Self::BadCompressedFrame => "bad compressed frame",
        })
    }
}

impl std::error::Error for FrameError {}

#[derive(Debug, Clone, PartialEq)]
pub enum IncomingFrame {
    Frame { data: Vec<u8>, binary: bool },
    Ping,
    Pong,
    Close { code: u16, reason: String },
    Partial,
}

#[derive(Debug, Default)]
pub struct FrameAssembler {
    max_bytes: usize,
    parts: Vec<Vec<u8>>,
    bytes: usize,
    binary: bool,
    deflated: bool,
}

impl FrameAssembler {
    pub fn new(max_frame_bytes: usize) -> Self {
        Self {
            max_bytes: max_frame_bytes,
            ..Self::default()
        }
    }

    /// Reassembles one data-channel fragment. The caller supplies the fragment boundary
    /// provided by the transport; the App Protocol itself has no stream length prefix.
    pub fn push(&mut self, message: &[u8]) -> Result<IncomingFrame, FrameError> {
        if message.is_empty() {
            return Err(FrameError::EmptyMessage);
        }
        let header = message[0];
        if header & PING != 0 {
            return Ok(IncomingFrame::Ping);
        }
        if header & PONG != 0 {
            return Ok(IncomingFrame::Pong);
        }
        if header & CLOSE != 0 {
            if message.len() < 3 {
                return Err(FrameError::CloseMessageTooShort);
            }
            return Ok(IncomingFrame::Close {
                code: u16::from_be_bytes([message[1], message[2]]),
                reason: String::from_utf8_lossy(&message[3..]).into_owned(),
            });
        }
        if header & !(LAST | BINARY | DEFLATE) != 0 {
            return Err(FrameError::UnknownHeaderBits);
        }

        let binary = header & BINARY != 0;
        let deflated = header & DEFLATE != 0;
        if !self.parts.is_empty() && (binary != self.binary || deflated != self.deflated) {
            return Err(FrameError::FragmentKindChanged);
        }
        self.binary = binary;
        self.deflated = deflated;
        let payload = &message[1..];
        self.bytes = self
            .bytes
            .checked_add(payload.len())
            .ok_or(FrameError::FrameTooLarge)?;
        if self.bytes > self.max_bytes {
            return Err(FrameError::FrameTooLarge);
        }
        self.parts.push(payload.to_vec());
        if header & LAST == 0 {
            return Ok(IncomingFrame::Partial);
        }

        let packed = if self.parts.len() == 1 {
            self.parts.pop().unwrap_or_default()
        } else {
            let mut packed = Vec::with_capacity(self.bytes);
            for part in self.parts.drain(..) {
                packed.extend_from_slice(&part);
            }
            packed
        };
        let binary = self.binary;
        let deflated = self.deflated;
        self.bytes = 0;
        self.binary = false;
        self.deflated = false;
        if !deflated {
            return Ok(IncomingFrame::Frame {
                data: packed,
                binary,
            });
        }
        let mut decoder = DeflateDecoder::new(packed.as_slice());
        let mut data = Vec::new();
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = decoder
                .read(&mut buffer)
                .map_err(|_| FrameError::BadCompressedFrame)?;
            if read == 0 {
                break;
            }
            if data.len() + read > self.max_bytes {
                return Err(FrameError::FrameTooLarge);
            }
            data.extend_from_slice(&buffer[..read]);
        }
        Ok(IncomingFrame::Frame { data, binary })
    }
}

pub fn split_frame(data: &[u8], binary: bool) -> Vec<Vec<u8>> {
    split_frame_with_options(data, binary, false, MAX_FRAGMENT_BYTES)
}

pub fn split_frame_with_options(
    data: &[u8],
    binary: bool,
    deflated: bool,
    max_message_bytes: usize,
) -> Vec<Vec<u8>> {
    let flag = (if binary { BINARY } else { 0 }) | (if deflated { DEFLATE } else { 0 });
    if data.is_empty() {
        return vec![vec![LAST | flag]];
    }
    let payload_bytes = max_message_bytes.saturating_sub(1).max(1);
    data.chunks(payload_bytes)
        .enumerate()
        .map(|(index, chunk)| {
            let last = if (index + 1) * payload_bytes >= data.len() {
                LAST
            } else {
                0
            };
            let mut frame = Vec::with_capacity(chunk.len() + 1);
            frame.push(flag | last);
            frame.extend_from_slice(chunk);
            frame
        })
        .collect()
}

pub fn control_frame(kind: u8) -> Vec<u8> {
    vec![kind]
}

pub fn close_frame(code: u16, reason: &str) -> Vec<u8> {
    let reason = truncate_utf8(reason.as_bytes(), 123);
    let mut frame = Vec::with_capacity(3 + reason.len());
    frame.push(CLOSE);
    frame.extend_from_slice(&code.to_be_bytes());
    frame.extend_from_slice(&reason);
    frame
}

fn truncate_utf8(bytes: &[u8], max: usize) -> Vec<u8> {
    let end = bytes.len().min(max);
    let mut result = bytes[..end].to_vec();
    while std::str::from_utf8(&result).is_err() {
        result.pop();
    }
    result
}
