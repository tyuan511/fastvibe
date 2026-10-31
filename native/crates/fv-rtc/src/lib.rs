//! Native account + official WebRTC transport, independent of server and GUI.
//! `AcceptedConnection::stream` carries newline-delimited fv-protocol messages; split it
//! and pass both halves to fv_server::serve_connection with ClientOrigin::Official.
pub mod account;
pub mod frames;
mod ice;
pub mod official;
pub mod peer;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid account issuer")]
    Issuer,
    #[error("account issuer does not match the credential issuer")]
    IssuerMismatch,
    #[error("sign-in callback was rejected")]
    Callback,
    #[error("sign-in was denied")]
    Denied,
    #[error("operation timed out")]
    Timeout,
    #[error("account authorization was refused")]
    Unauthorized,
    #[error("service request failed (HTTP {0})")]
    Http(u16),
    #[error("invalid service response")]
    Response,
    #[error("signaling stopped: {0}")]
    Signaling(&'static str),
    #[error("RTC protocol violation: {0}")]
    Protocol(&'static str),
    #[error("WebRTC operation failed: {0}")]
    Rtc(#[from] webrtc::Error),
    #[error("I/O operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("stored account is invalid")]
    Storage,
    #[error("service transport failed")]
    Transport,
}

pub type Result<T> = std::result::Result<T, Error>;
