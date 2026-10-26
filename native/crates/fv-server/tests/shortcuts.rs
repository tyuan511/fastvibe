use std::path::Path;
use std::sync::Arc;

use fv_agent::testing::ScriptedModel;
use fv_client::Client;
use fv_protocol::methods::{Initialize, SettingsGet, SettingsSet};
use fv_protocol::shortcuts::{ShortcutEdit, ShortcutId::*, ShortcutOverrides, resolve};
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};

async fn connect(
    socket: &Path,
) -> (
    Client,
    tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) {
    let (client, notes) = Client::connect_unix(socket).await.unwrap();
    let initialized = client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "shortcuts-test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert!(initialized.features.iter().any(|f| f == "shortcuts"));
    (client, notes)
}

async fn serve(
    dir: &Path,
    name: &str,
) -> (
    Client,
    tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) {
    let state = Arc::new(
        ServerState::new(
            dir.into(),
            fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([]))),
        )
        .unwrap(),
    );
    let socket = dir.join(name);
    tokio::spawn(UnixServer::bind(state, &socket).await.unwrap().run());
    connect(&socket).await
}

#[tokio::test]
async fn shortcut_row_changes_merge_across_clients_broadcast_and_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (a, _) = serve(dir.path(), "first.sock").await;
    let (b, mut notes) = connect(&dir.path().join("first.sock")).await;
    let defaults = a.call::<SettingsGet>(Empty {}).await.unwrap();
    assert!(defaults.send_on_enter && defaults.shortcuts.is_empty());
    let (first, second) = tokio::join!(
        a.call::<SettingsSet>(AppSettingsPatch {
            shortcut: Some(ShortcutEdit::Set {
                id: NewChat,
                binding: "Cmd+K".into()
            }),
            send_on_enter: Some(false),
            ..Default::default()
        }),
        b.call::<SettingsSet>(AppSettingsPatch {
            shortcut: Some(ShortcutEdit::Set {
                id: ToggleSidebar,
                binding: "alt+shift+b".into()
            }),
            custom_system_prompt: Some("keep this".into()),
            ..Default::default()
        })
    );
    first.unwrap();
    second.unwrap();
    let current = a.call::<SettingsGet>(Empty {}).await.unwrap();
    assert!(!current.send_on_enter);
    assert_eq!(current.custom_system_prompt, "keep this");
    assert_eq!(resolve(NewChat, &current.shortcuts), Some("mod+k"));
    assert_eq!(resolve(CommandPalette, &current.shortcuts), None);
    assert_eq!(
        resolve(ToggleSidebar, &current.shortcuts),
        Some("alt+shift+b")
    );
    let heard = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(ServerNotification::SettingsChanged(s)) = notes.recv().await
                && s == current
            {
                break s;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(heard, current);
    let (restored, _) = serve(dir.path(), "restarted.sock").await;
    assert_eq!(
        restored.call::<SettingsGet>(Empty {}).await.unwrap(),
        current
    );
    let disabled = restored
        .call::<SettingsSet>(AppSettingsPatch {
            shortcut: Some(ShortcutEdit::Disable { id: Stop }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(resolve(Stop, &disabled.shortcuts), None);
    let restored_default = restored
        .call::<SettingsSet>(AppSettingsPatch {
            shortcut: Some(ShortcutEdit::Restore { id: CommandPalette }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        resolve(CommandPalette, &restored_default.shortcuts),
        Some("mod+k")
    );
    assert_eq!(resolve(NewChat, &restored_default.shortcuts), None);
    let reset = restored
        .call::<SettingsSet>(AppSettingsPatch {
            shortcuts: Some(ShortcutOverrides::new()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(reset.shortcuts.is_empty());
    assert!(!reset.send_on_enter);
    assert_eq!(reset.custom_system_prompt, "keep this");
}

#[tokio::test]
async fn invalid_shortcuts_reject_the_entire_patch_without_touching_preferences() {
    let dir = tempfile::tempdir().unwrap();
    let (client, _) = serve(dir.path(), "s.sock").await;
    for bad in ["a", "mod+c", "mod+k+l", "mod++", "mod+unknown"] {
        assert!(
            client
                .call::<SettingsSet>(AppSettingsPatch {
                    shortcut: Some(ShortcutEdit::Set {
                        id: NewChat,
                        binding: bad.into()
                    }),
                    glass: Some(true),
                    ..Default::default()
                })
                .await
                .is_err()
        );
        assert_eq!(
            client.call::<SettingsGet>(Empty {}).await.unwrap(),
            AppSettings::default()
        );
    }
    let duplicate = ShortcutOverrides::from([
        (NewChat, Some("cmd+k".into())),
        (Settings, Some("mod+k".into())),
    ]);
    assert!(
        client
            .call::<SettingsSet>(AppSettingsPatch {
                shortcuts: Some(duplicate),
                send_on_enter: Some(false),
                ..Default::default()
            })
            .await
            .is_err()
    );
    assert!(
        client
            .call::<SettingsSet>(AppSettingsPatch {
                shortcuts: Some(Default::default()),
                shortcut: Some(ShortcutEdit::Disable { id: Send }),
                ..Default::default()
            })
            .await
            .is_err()
    );
    assert_eq!(
        client.call::<SettingsGet>(Empty {}).await.unwrap(),
        AppSettings::default()
    );
    let replaced = client
        .call::<SettingsSet>(AppSettingsPatch {
            shortcuts: Some(ShortcutOverrides::from([
                (Settings, Some("ctrl+alt+f8".into())),
                (Stop, None),
            ])),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(resolve(Settings, &replaced.shortcuts), Some("ctrl+alt+f8"));
    assert_eq!(resolve(Stop, &replaced.shortcuts), None);
}
