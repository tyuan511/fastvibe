//! Local browser services. Source profiles are read only; automation owns a separate profile.
mod cdp;
mod profiles;
pub use cdp::SystemBrowser;
pub use profiles::{Cookie, Engine, Profile, engines, profiles, read_cookies};
