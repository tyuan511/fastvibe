//! One SSH host per workspace window. Every RPC, notification and pending question uses
//! that window's Backend; identical remote/local thread ids can never share a view cache.
use super::*;

impl Workspace {
    pub(super) fn open_ssh_workspace(
        &mut self,
        name: String,
        host: fv_daemon::ssh::SshHost,
        recovery_dir: std::path::PathBuf,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let palette = self.palette.clone();
        let title = format!("FastVibe — {name} (SSH)");
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(gpui_kit::px(1100.), gpui_kit::px(720.)),
                cx,
            ))),
            titlebar: Some(TitlebarOptions {
                title: Some(title.into()),
                appears_transparent: true,
                traffic_light_position: Some(point(gpui_kit::px(24.), gpui_kit::px(24.))),
            }),
            window_background: crate::vibrancy::background(palette.glass()),
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, move |window, cx| {
            crate::vibrancy::set(window, &palette);
            cx.new(|cx| Self::new_ssh(palette, name, host, recovery_dir, window, cx))
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    fn new_ssh(
        palette: Palette,
        name: String,
        host: fv_daemon::ssh::SshHost,
        recovery_dir: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self::base(palette, window, cx);
        this.ssh_host = Some(name);
        this.live_appearance = true;
        // update_data_dir intentionally remains absent: update/restart controls must never
        // mistake a remote server for the local application installation.
        let recovery = cx.background_executor().spawn(async move {
            std::fs::create_dir_all(&recovery_dir).map_err(|e| e.to_string())?;
            crate::pane_layout::Storage::open(recovery_dir.join("gui-workspace.json"))
                .map_err(|e| e.to_string())
        });
        cx.observe_self(|this, cx| this.schedule_pane_save(cx))
            .detach();
        cx.on_app_quit(|this, cx| {
            let job = this.pane_save_job(cx);
            cx.background_executor().spawn(async move {
                if let Some(job) = job {
                    let _ = job.run();
                }
            })
        })
        .detach();
        cx.on_release(|this, cx| {
            if let Some(job) = this.pane_save_job(cx) {
                let _ = job.run();
            }
        })
        .detach();
        let (ready, mut events) = Backend::start_ssh(host);
        cx.spawn(async move |this, cx| {
            let recovery = recovery.await;
            let backend = ready.await;
            let _ = this.update(cx, |this, cx| {
                this.backend = backend;
                match recovery {
                    Ok(storage) => this.restore_panes(storage),
                    Err(error) => this.notice = Some(Notice::Failed(error)),
                }
                cx.notify();
            });
            while let Some(event) = events.next().await {
                if this
                    .update(cx, |this, cx| this.on_event(event, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        this
    }
}
