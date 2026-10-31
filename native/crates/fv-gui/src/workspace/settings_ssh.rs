//! Saved OpenSSH hosts and explicit native server installation.
use super::*;
use std::path::PathBuf;
#[path = "../ssh_profiles.rs"]
mod profiles;
use profiles::{Profile, Profiles};

pub(super) struct SshSettings {
    path: Option<PathBuf>,
    profiles: Profiles,
    loaded: bool,
    busy: Option<String>,
    notice: Option<String>,
    edit: Option<HostEdit>,
    confirm_delete: Option<String>,
}
struct HostEdit {
    id: String,
    name: Entity<InputState>,
    host: Entity<InputState>,
    user: Entity<InputState>,
    port: Entity<InputState>,
    identity: Entity<InputState>,
    binary: Entity<InputState>,
    data: Entity<InputState>,
}
impl SshSettings {
    pub(super) fn new(_window: &mut Window, _cx: &mut App) -> Self {
        Self {
            path: None,
            profiles: Profiles::default(),
            loaded: false,
            busy: None,
            notice: None,
            edit: None,
            confirm_delete: None,
        }
    }
}
impl Workspace {
    pub(super) fn refresh_ssh_settings(&mut self, cx: &mut Context<Self>) {
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.ssh.loaded || s.ssh.busy.is_some() {
            return;
        }
        s.ssh.loaded = true;
        let Some(dir) = self.update_data_dir.as_ref() else {
            s.ssh.notice = Some(
                trs!(
                    self.app_settings.language == UiLanguage::English,
                    "ssh.local_only"
                )
                .into(),
            );
            return;
        };
        let path = dir.join("ssh-hosts.json");
        match Profiles::load(&path) {
            Ok(profiles) => {
                s.ssh.profiles = profiles;
                s.ssh.path = Some(path);
            }
            Err(e) => {
                s.ssh.notice = Some(tr!(
                    self.app_settings.language == UiLanguage::English,
                    "ssh.read_failed",
                    error = e
                ))
            }
        }
        cx.notify();
    }

    fn edit_ssh_host(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(s) = self.settings.as_ref() else {
            return;
        };
        if s.ssh.busy.is_some() || s.ssh.path.is_none() {
            return;
        }
        let saved = id
            .as_ref()
            .and_then(|id| s.ssh.profiles.hosts.iter().find(|p| &p.id == id))
            .cloned();
        let field = |value: String, placeholder: &str, window: &mut Window, cx: &mut App| {
            let state = input(window, cx, placeholder, false);
            state.update(cx, |s, cx| s.set_value(value, window, cx));
            state
        };
        let edit = HostEdit {
            id: saved
                .as_ref()
                .map_or_else(|| uuid::Uuid::new_v4().to_string(), |p| p.id.clone()),
            name: field(
                saved.as_ref().map_or_else(String::new, |p| p.name.clone()),
                "Build server",
                window,
                cx,
            ),
            host: field(
                saved.as_ref().map_or_else(String::new, |p| p.host.clone()),
                "my-ssh-alias",
                window,
                cx,
            ),
            user: field(
                saved
                    .as_ref()
                    .and_then(|p| p.user.clone())
                    .unwrap_or_default(),
                "",
                window,
                cx,
            ),
            port: field(
                saved
                    .as_ref()
                    .and_then(|p| p.port)
                    .map_or_else(String::new, |p| p.to_string()),
                "22",
                window,
                cx,
            ),
            identity: field(
                saved
                    .as_ref()
                    .and_then(|p| p.identity_file.as_ref())
                    .map_or_else(String::new, |p| p.display().to_string()),
                "/Users/me/.ssh/id_ed25519",
                window,
                cx,
            ),
            binary: field(
                saved
                    .as_ref()
                    .map_or_else(String::new, |p| p.server_binary.clone()),
                "/home/me/.local/bin/fastvibe-server",
                window,
                cx,
            ),
            data: field(
                saved
                    .as_ref()
                    .map_or_else(String::new, |p| p.data_dir.clone()),
                "/home/me/.local/share/FastVibeNative",
                window,
                cx,
            ),
        };
        if let Some(s) = self.settings.as_mut() {
            s.ssh.edit = Some(edit);
            s.ssh.notice = None;
        }
        cx.notify();
    }

    fn save_ssh_host(&mut self, cx: &mut Context<Self>) {
        let english = self.english();
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        let Some(edit) = s.ssh.edit.as_ref() else {
            return;
        };
        let Some(path) = s.ssh.path.as_ref() else {
            return;
        };
        let optional = |field: &Entity<InputState>| {
            let text = value(field, cx);
            (!text.is_empty()).then_some(text)
        };
        let port = match optional(&edit.port).map(|p| p.parse::<u16>()) {
            Some(Ok(p)) if p > 0 => Some(p),
            None => None,
            _ => {
                s.ssh.notice = Some(trs!(english, "ssh.invalid_port").into());
                cx.notify();
                return;
            }
        };
        let profile = Profile {
            id: edit.id.clone(),
            name: value(&edit.name, cx),
            host: value(&edit.host, cx),
            user: optional(&edit.user),
            port,
            identity_file: optional(&edit.identity).map(PathBuf::from),
            server_binary: value(&edit.binary, cx),
            data_dir: value(&edit.data, cx),
        };
        if let Err(error) = profile.validate() {
            s.ssh.notice = Some(error);
            cx.notify();
            return;
        }
        let mut next = s.ssh.profiles.clone();
        if let Some(existing) = next.hosts.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile;
        } else {
            next.hosts.push(profile);
        }
        match next.save(path, &s.ssh.profiles) {
            Ok(()) => {
                s.ssh.profiles = next;
                s.ssh.edit = None;
                s.ssh.notice = Some(trs!(english, "ssh.saved").into());
            }
            Err(error) => s.ssh.notice = Some(error),
        }
        cx.notify();
    }

    fn delete_ssh_host(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.ssh.busy.is_some() {
            return;
        }
        if s.ssh.confirm_delete.as_ref() != Some(&id) {
            s.ssh.confirm_delete = Some(id);
            cx.notify();
            return;
        }
        let Some(path) = s.ssh.path.as_ref() else {
            return;
        };
        let mut next = s.ssh.profiles.clone();
        next.hosts.retain(|p| p.id != id);
        match next.save(path, &s.ssh.profiles) {
            Ok(()) => {
                s.ssh.profiles = next;
                s.ssh.confirm_delete = None;
            }
            Err(error) => s.ssh.notice = Some(error),
        }
        cx.notify();
    }

    fn ssh_profile(&self, id: &str) -> Option<Profile> {
        self.settings
            .as_ref()?
            .ssh
            .profiles
            .hosts
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    fn test_ssh_host(&mut self, id: String, cx: &mut Context<Self>) {
        self.run_ssh_operation(id, None, cx);
    }

    fn pick_ssh_binary(&mut self, id: String, cx: &mut Context<Self>) {
        if self.settings.as_ref().is_none_or(|s| s.ssh.busy.is_some()) {
            return;
        }
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(trs!(self.english(), "ssh.choose_binary").into()),
        });
        let owner = self.settings.as_ref().map(|s| s.search.entity_id());
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = picked.await
                && let Some(path) = paths.into_iter().next()
            {
                let _ = this.update(cx, |this, cx| {
                    if this.settings.as_ref().map(|s| s.search.entity_id()) == owner {
                        this.run_ssh_operation(id, Some(path), cx);
                    }
                });
            }
        })
        .detach();
    }

    fn run_ssh_operation(&mut self, id: String, binary: Option<PathBuf>, cx: &mut Context<Self>) {
        let Some(profile) = self.ssh_profile(&id) else {
            return;
        };
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let english = self.english();
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.ssh.busy.is_some() {
            return;
        }
        s.ssh.busy = Some(id);
        s.ssh.notice = Some(trs!(english, "ssh.testing").into());
        let owner = s.search.entity_id();
        let installing = binary.is_some();
        let host = profile.ssh();
        let (progress_tx, mut progress_rx) = futures_channel::mpsc::unbounded::<&'static str>();
        let task = backend.task(async move {
            fv_env::initialize().await;
            let target = host.probe().await?;
            let mut active_mismatch = false;
            if let Some(binary) = binary {
                profiles::verify_binary(&binary, &target)?;
                let _ = progress_tx.unbounded_send("ssh.uploading");
                tokio::time::timeout(
                    std::time::Duration::from_secs(180),
                    host.install(&binary, &target.os, &target.arch),
                )
                .await
                .map_err(|_| "SSH install timed out".to_string())??;
                let _ = progress_tx.unbounded_send("ssh.verifying");
                // A copied file is not success until the actual resident server speaks this protocol.
                let connection = host
                    .connect_current(
                        "fastvibe-gui-install",
                        env!("CARGO_PKG_VERSION"),
                        fv_protocol::DESKTOP_REQUIRED_FEATURES,
                    )
                    .await?;
                active_mismatch = connection.version_mismatch;
            }
            Ok::<_, String>((target, active_mismatch))
        });
        cx.spawn(async move |this, cx| {
            use futures_util::StreamExt as _;
            while let Some(key) = progress_rx.next().await {
                let _ = this.update(cx, |this, cx| {
                    let english = this.english();
                    if let Some(s) = this
                        .settings
                        .as_mut()
                        .filter(|s| s.search.entity_id() == owner)
                    {
                        s.ssh.notice = Some(trs!(english, key).into());
                        cx.notify();
                    }
                });
            }
            let result = task
                .await
                .map_err(|e| e.to_string())
                .and_then(|result| result);
            let _ = this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner)
                {
                    s.ssh.busy = None;
                    s.ssh.notice = Some(match result {
                        Ok((_, true)) => trs!(english, "ssh.installed_resident_older").into(),
                        Ok((target, false)) => tr!(
                            english,
                            "ssh.operation_ok",
                            action = if installing {
                                trs!(english, "ssh.installed")
                            } else {
                                trs!(english, "ssh.reachable")
                            },
                            os = target.os,
                            arch = target.arch
                        ),
                        Err(error) => tr!(english, "ssh.operation_failed", error = error),
                    });
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn connect_ssh_host(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(profile) = self.ssh_profile(&id) else {
            return;
        };
        let Some(dir) = self.update_data_dir.clone() else {
            return;
        };
        let result = self.open_ssh_workspace(
            profile.name.clone(),
            profile.ssh(),
            dir.join("ssh-workspaces").join(&profile.id),
            cx,
        );
        let english = self.english();
        if let Some(s) = self.settings.as_mut() {
            s.ssh.notice = Some(match result {
                Ok(()) => trs!(english, "ssh.opened").into(),
                Err(error) => tr!(english, "ssh.operation_failed", error = error),
            });
        }
        cx.notify();
    }

    pub(super) fn render_settings_ssh(
        &self,
        s: &SettingsState,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let english = self.english();
        let ssh = &s.ssh;
        let busy = ssh.busy.is_some();
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(trs!(english, "ssh.description")),
            )
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(trs!(english, "ssh.hostkey_hint")),
            );
        if let Some(notice) = &ssh.notice {
            body = body.child(div().text_size(px(TEXT_SM)).child(notice.clone()));
        }
        if let Some(edit) = &ssh.edit {
            let mut form = card(p).p(px(16.)).gap(px(10.));
            for (label, field) in [
                ("ssh.name", &edit.name),
                ("ssh.host", &edit.host),
                ("ssh.user", &edit.user),
                ("ssh.port", &edit.port),
                ("ssh.identity", &edit.identity),
                ("ssh.server_path", &edit.binary),
                ("ssh.data_path", &edit.data),
            ] {
                form = form.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            div()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(trs!(english, label)),
                        )
                        .child(crate::ui::input(field)),
                );
            }
            body = body.child(
                form.child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            outline_button("ssh-save", p)
                                .child(trs!(english, "settings.save"))
                                .on_click(cx.listener(|this, _, _, cx| this.save_ssh_host(cx))),
                        )
                        .child(
                            outline_button("ssh-cancel", p)
                                .child(trs!(english, "settings.cancel"))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if let Some(s) = this.settings.as_mut() {
                                        s.ssh.edit = None;
                                    }
                                    cx.notify();
                                })),
                        ),
                ),
            );
        } else {
            body = body.child(
                outline_button("ssh-add", p)
                    .when(ssh.path.is_none(), |d| d.opacity(0.5))
                    .child(trs!(english, "ssh.add"))
                    .on_click(
                        cx.listener(|this, _, window, cx| this.edit_ssh_host(None, window, cx)),
                    ),
            );
        }
        if ssh.profiles.hosts.is_empty() && ssh.edit.is_none() {
            body = body.child(
                div()
                    .py(px(20.))
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(trs!(english, "ssh.empty")),
            );
        }
        for profile in &ssh.profiles.hosts {
            let id = profile.id.clone();
            let edit_id = id.clone();
            let test_id = id.clone();
            let install_id = id.clone();
            let connect_id = id.clone();
            let deleting = ssh.confirm_delete.as_ref() == Some(&id);
            body = body.child(
                card(p)
                    .p(px(14.))
                    .gap(px(8.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(icon("server-stack01", 16., p.c(Token::MutedForeground)))
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(profile.name.clone()),
                            ),
                    )
                    .child(div().text_size(px(TEXT_XS)).muted(p).child(format!(
                            "{}{}{}",
                            profile
                                .user
                                .as_ref()
                                .map_or_else(String::new, |u| format!("{u}@")),
                            profile.host,
                            profile.port.map_or_else(String::new, |p| format!(":{p}"))
                        )))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(8.))
                            .child(
                                outline_button(SharedString::from(format!("ssh-connect-{id}")), p)
                                    .child(trs!(english, "ssh.connect"))
                                    .when(busy, |d| d.opacity(0.5))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if !busy {
                                            this.connect_ssh_host(connect_id.clone(), cx);
                                        }
                                    })),
                            )
                            .child(
                                outline_button(SharedString::from(format!("ssh-test-{id}")), p)
                                    .child(trs!(english, "ssh.test"))
                                    .when(busy, |d| d.opacity(0.5))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if !busy {
                                            this.test_ssh_host(test_id.clone(), cx);
                                        }
                                    })),
                            )
                            .child(
                                outline_button(SharedString::from(format!("ssh-install-{id}")), p)
                                    .child(trs!(english, "ssh.install"))
                                    .when(busy, |d| d.opacity(0.5))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if !busy {
                                            this.pick_ssh_binary(install_id.clone(), cx);
                                        }
                                    })),
                            )
                            .child(
                                outline_button(SharedString::from(format!("ssh-edit-{id}")), p)
                                    .child(trs!(english, "ssh.edit"))
                                    .when(busy, |d| d.opacity(0.5))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.edit_ssh_host(Some(edit_id.clone()), window, cx)
                                    })),
                            )
                            .child(
                                outline_button(SharedString::from(format!("ssh-delete-{id}")), p)
                                    .text_color(p.c(Token::Destructive))
                                    .child(trs!(
                                        english,
                                        if deleting {
                                            "ssh.confirm_delete"
                                        } else {
                                            "ssh.delete"
                                        }
                                    ))
                                    .when(busy, |d| d.opacity(0.5))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.delete_ssh_host(id.clone(), cx)
                                    })),
                            ),
                    ),
            );
        }
        body.into_any_element()
    }
}
