use fv_protocol::ClientRequest;
use fv_protocol::types::ClientOrigin;

/// Whether a connection of this origin may call this method.
///
/// Local (the owner's own unix socket) and Ssh (ssh already authenticated them) may call
/// everything. A remote origin gets the allowlist below. The `match` is exhaustive on purpose:
/// a method added to the protocol does not compile until someone decides who may call it,
/// where a denylist would have exposed it by default.
pub fn allows(origin: ClientOrigin, request: &ClientRequest) -> bool {
    match origin {
        ClientOrigin::Local | ClientOrigin::Ssh => true,
        ClientOrigin::Lan | ClientOrigin::Official => match request {
            ClientRequest::Initialize { .. }
            | ClientRequest::ThreadList { .. }
            | ClientRequest::ThreadStart { .. }
            | ClientRequest::ThreadResume { .. }
            | ClientRequest::ThreadUnsubscribe { .. }
            | ClientRequest::TurnStart { .. }
            | ClientRequest::TurnInterrupt { .. } => true,
        },
    }
}
