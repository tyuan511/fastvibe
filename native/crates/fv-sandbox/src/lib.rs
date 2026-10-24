//! What a command and a patch are allowed to touch, and how that is enforced.
//!
//! Modes and approval policies are codex's. Enforcement is macOS Seatbelt (`sandbox-exec`),
//! built the way codex builds it; on another system there is no sandbox to apply, so only
//! `danger-full-access` can be honoured and anything else is reported as unavailable.

mod policy;
mod safe;
mod seatbelt;

pub use policy::{ApprovalPolicy, Policy, SandboxMode, default_writable_roots};
pub use safe::{is_known_safe, looks_denied};
pub use seatbelt::{Wrapped, available, wrap};
