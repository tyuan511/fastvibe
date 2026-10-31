use super::AccountSettings;
use fv_protocol::account::{AccountState, AccountUser};
use fv_protocol::official::{OfficialState, OfficialStatus};
use gpui_kit::{AppContext, Context, IntoElement, Render, TestAppContext, Window, div, gpui};

struct Fixture;
impl Render for Fixture {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

#[gpui::test]
fn finished_login_drops_authorization_url_and_retains_safe_failure(cx: &mut TestAppContext) {
    let window = cx.add_window(|_, _| Fixture);
    cx.update_window(window.into(), |_, window, cx| {
        let mut state = AccountSettings::new(window, cx);
        state.account = Some(AccountState::SigningIn {
            origin: "https://app.fastvibe.dev".into(),
        });
        state.authorize_url = Some("https://app.fastvibe.dev/authorize?state=ephemeral".into());
        state.observe_account(
            AccountState::SignedOut {
                origin: "https://app.fastvibe.dev".into(),
                error: Some("Login expired".into()),
            },
            true,
        );
        assert!(
            state.authorize_url.is_none(),
            "an expired page cannot be reopened"
        );
        assert_eq!(state.error.as_deref(), Some("Login expired"));
        state.observe_account(
            AccountState::SignedIn {
                origin: "https://app.fastvibe.dev".into(),
                user: AccountUser {
                    id: "user-1".into(),
                    login: "reader".into(),
                    avatar_url: String::new(),
                    email: None,
                },
            },
            true,
        );
        assert!(
            state.error.is_none(),
            "successful retry clears the old failure"
        );
        assert!(state.authorize_url.is_none());
    })
    .unwrap();
}

#[gpui::test]
fn official_status_refresh_updates_clean_name_but_preserves_unsaved_name(cx: &mut TestAppContext) {
    let window = cx.add_window(|_, _| Fixture);
    cx.update_window(window.into(), |_, window, cx| {
        let mut state = AccountSettings::new(window, cx);
        let status = |name: &str| OfficialState {
            enabled: true,
            name: name.into(),
            status: OfficialStatus::Online,
            device_id: None,
            peers: vec![],
            error: None,
        };
        state.observe_official(status("Work Mac"), window, cx);
        assert_eq!(state.name.read(cx).value().as_ref(), "Work Mac");
        state.observe_official(status("Renamed elsewhere"), window, cx);
        assert_eq!(state.name.read(cx).value().as_ref(), "Renamed elsewhere");
        state
            .name
            .update(cx, |input, cx| input.set_value("My draft", window, cx));
        state.observe_official(status("New server name"), window, cx);
        assert_eq!(state.name.read(cx).value().as_ref(), "My draft");
        assert_eq!(state.official.as_ref().unwrap().name, "New server name");
    })
    .unwrap();
}
