//! Public account state. Device credentials and PKCE verifiers never enter fv-protocol.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountUser {
    pub id: String,
    pub login: String,
    pub avatar_url: String,
    pub email: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AccountState {
    SignedOut {
        origin: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    SigningIn {
        origin: String,
    },
    SignedIn {
        origin: String,
        user: AccountUser,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountLoginResponse {
    pub authorize_url: String,
}
