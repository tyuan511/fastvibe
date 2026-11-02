//! iOS interface state without BSD route-table access.
//!
//! iOS can enumerate its interfaces and addresses through netdev, but the SDK
//! does not expose the BSD routing constants used by the macOS route parser.
//! Keep host candidates while leaving default-route and home-router discovery
//! unavailable; iroh can still use STUN and relay fallback.

pub(super) use super::netdev_impl::get_state;
use super::{DefaultRouteDetails, HomeRouter};

pub async fn default_route() -> Option<DefaultRouteDetails> {
    None
}

pub(super) fn home_router() -> Option<HomeRouter> {
    None
}
