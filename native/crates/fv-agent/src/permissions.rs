//! What the tools of a turn may do, and how they ask when they may not: the sandbox policy, when
//! to ask the user, and the way to ask.

use std::sync::Arc;

use futures_util::future::BoxFuture;
pub use fv_sandbox::{ApprovalPolicy, Policy, SandboxMode};

/// What the user answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// This once.
    Approved,
    /// This, and the same again for the rest of the conversation.
    ApprovedForSession,
    Denied,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApprovalKind {
    /// A command that is not known to be safe, or that wants to leave the sandbox.
    Command {
        command: String,
        cwd: Option<String>,
    },
    /// A patch that writes where the sandbox would not let a command write.
    Patch { files: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalRequest {
    /// The tool call this is for.
    pub call_id: String,
    pub kind: ApprovalKind,
    /// Why, in the model's words or ours.
    pub reason: Option<String>,
}

impl ApprovalRequest {
    /// What "the same again" means: the command text, or the files of the patch.
    pub fn key(&self) -> String {
        match &self.kind {
            ApprovalKind::Command { command, cwd } => {
                format!("command\0{}\0{}", cwd.as_deref().unwrap_or(""), command)
            }
            ApprovalKind::Patch { files } => format!("patch\0{}", files.join("\0")),
        }
    }
}

/// The way to ask. A client may be gone, or decline: the answer is then `Denied`.
pub trait Approver: Send + Sync {
    fn approve(&self, request: ApprovalRequest) -> BoxFuture<'static, Decision>;
}

pub struct Permissions {
    pub policy: Policy,
    pub approval: ApprovalPolicy,
    pub approver: Option<Arc<dyn Approver>>,
}

impl Permissions {
    /// Ask the user. With nobody to ask, the answer is no.
    pub async fn ask(&self, request: ApprovalRequest) -> Decision {
        match &self.approver {
            Some(approver) => approver.approve(request).await,
            None => Decision::Denied,
        }
    }
}
