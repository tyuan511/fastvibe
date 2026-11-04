//! Shared native mobile protocol, transcript, account and transport runtime.

mod ffi;
mod frames;
mod protocol;
mod runtime;
mod support;
mod transcript;

#[cfg(any(feature = "mobile-client", feature = "iroh-transport"))]
pub mod relay_config;

#[cfg(feature = "iroh-transport")]
pub mod iroh_transport;
#[cfg(feature = "mobile-client")]
pub mod mobile_client;

pub use ffi::*;
pub use frames::*;
pub use protocol::*;
pub use runtime::CoreHandle;
pub use transcript::TranscriptStore;
