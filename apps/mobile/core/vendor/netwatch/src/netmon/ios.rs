//! iOS network monitor fallback.
//!
//! iOS does not expose the BSD route socket constants used by macOS. Network
//! changes are surfaced by the native lifecycle and the next iroh operation;
//! the endpoint still enumerates interfaces and candidates through netdev.

use n0_error::stack_error;
use tokio::sync::mpsc;

use super::actor::NetworkMessage;

#[stack_error(derive, add_meta)]
pub struct Error;

#[derive(Debug)]
pub(super) struct RouteMonitor {
    _sender: mpsc::Sender<NetworkMessage>,
}

impl RouteMonitor {
    pub(super) fn new(sender: mpsc::Sender<NetworkMessage>) -> Result<Self, Error> {
        Ok(Self { _sender: sender })
    }
}
