//! Explicit configuration import and project defaults, backed by typed protocol methods.
use super::*;
use fv_protocol::migration::*;

fn dataset_disposition(value: &str, english: bool) -> &'static str {
    match value {
        "import" => trs!(english, "settings.migration_converted"),
        "archive" => trs!(english, "settings.migration_preserved"),
        _ => trs!(english, "settings.migration_skipped"),
    }
}
fn dataset_name(value: &str, english: bool) -> String {
    let key = match value {
        "conversations" => "settings.migration_threads",
        "projects" => "settings.migration_projects",
        "settings" => "settings.migration_settings",
        "providers" => "settings.providers",
        "subscriptionCredentials" => "settings.migration_credentials",
        "usage" => "settings.migration_usage",
        "images" => "settings.migration_images",
        name if name.starts_with("checkpoint") => "settings.migration_checkpoints",
        name if name.starts_with("dag") => "settings.migration_dags",
        name if name.starts_with("queue") || name == "message-queue.json" => {
            "settings.migration_queue"
        }
        name if name.starts_with("scheduled") => "settings.migration_schedules",
        name if name.starts_with("reasoning") => "settings.migration_reasoning",
        name if name.starts_with("memory") => "settings.migration_memory",
        _ => return value.into(),
    };
    trs!(english, key).into()
}

impl Workspace {
    pub(super) fn scan_electron_migration(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.import.migration_busy {
            return;
        }
        s.import.migration_busy = true;
        s.import.migration_notice = None;
        s.import.migration = None;
        s.import.migration_include_api_keys = false;
        s.import.migration_overwrite_settings = false;
        let owner = s.search.entity_id();
        let call =
            b.call::<ElectronMigrationScan>(ElectronMigrationScanParams { source_dir: None });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner)
                {
                    s.import.migration_busy = false;
                    match result {
                        Ok(scan) => s.import.migration = Some(scan),
                        Err(e) => s.import.migration_notice = Some(e.to_string()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn commit_electron_migration(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.import.migration_busy {
            return;
        }
        let Some(scan) = s.import.migration.as_ref().filter(|s| !s.already_imported) else {
            return;
        };
        let params = ElectronMigrationCommitParams {
            source_dir: scan.source_dir.clone(),
            fingerprint: scan.fingerprint.clone(),
            include_api_keys: s.import.migration_include_api_keys,
            overwrite_settings: s.import.migration_overwrite_settings,
        };
        s.import.migration_busy = true;
        let owner = s.search.entity_id();
        let call = b.call::<ElectronMigrationCommit>(params);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner)
                {
                    s.import.migration_busy = false;
                    match result {
                        Ok(r) => {
                            if let Some(scan) = &mut s.import.migration {
                                scan.already_imported = true;
                            }
                            s.import.migration_notice = Some(format!(
                                "{}\n{}: {} · {}: {} · {}: {} · {}: {}\n{}\n{}",
                                trs!(english, "settings.migration_done"),
                                trs!(english, "settings.migration_threads"),
                                r.imported_threads,
                                trs!(english, "settings.project_defaults_title"),
                                r.imported_projects,
                                trs!(english, "settings.providers"),
                                r.imported_providers,
                                trs!(english, "settings.api_key"),
                                r.imported_api_keys,
                                r.archive_dir,
                                r.warnings.join("\n")
                            ));
                        }
                        Err(e) => s.import.migration_notice = Some(e.to_string()),
                    }
                }
                this.refresh_threads(cx);
                this.refresh_projects(cx);
                this.refresh_providers(cx);
                this.refresh_models(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn electron_migration_pane(
        &self,
        s: &SettingsState,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let english = self.english();
        let busy = s.import.migration_busy;
        let mut body = card(p)
            .p(px(16.))
            .gap(px(10.))
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(trs!(english, "settings.migration_title")),
            )
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(trs!(english, "settings.migration_desc")),
            )
            .child(
                outline_button("scan-electron", p)
                    .when(busy, |d| d.opacity(0.5))
                    .child(if busy {
                        trs!(english, "settings.reading")
                    } else {
                        trs!(english, "settings.migration_scan")
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !busy {
                            this.scan_electron_migration(cx);
                        }
                    })),
            );
        if let Some(scan) = &s.import.migration {
            body = body.child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(scan.source_dir.clone()),
            );
            for dataset in &scan.datasets {
                body = body.child(div().text_size(px(TEXT_XS)).child(format!(
                    "{} · {} · {}",
                    dataset_name(&dataset.name, english),
                    dataset.count,
                    dataset_disposition(&dataset.disposition, english)
                )));
            }
            for warning in &scan.warnings {
                body = body.child(
                    div()
                        .text_size(px(TEXT_XS))
                        .text_color(p.c(Token::Warning))
                        .child(warning.clone()),
                );
            }
            let checked = s.import.migration_include_api_keys;
            body = body.child(
                outline_button("migration-api-keys", p)
                    .child(checkbox(checked, p))
                    .child(trs!(english, "settings.migration_keys"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !busy && let Some(s) = &mut this.settings {
                            s.import.migration_include_api_keys = !checked;
                        }
                        cx.notify();
                    })),
            );
            let overwrite = s.import.migration_overwrite_settings;
            body = body.child(
                outline_button("migration-overwrite", p)
                    .child(checkbox(overwrite, p))
                    .child(trs!(english, "settings.migration_overwrite"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !busy && let Some(s) = &mut this.settings {
                            s.import.migration_overwrite_settings = !overwrite;
                        }
                        cx.notify();
                    })),
            );
            let disabled = busy || scan.already_imported;
            body = body.child(
                outline_button("commit-electron", p)
                    .when(disabled, |d| d.opacity(0.5))
                    .child(if scan.already_imported {
                        trs!(english, "settings.migration_already")
                    } else if busy {
                        trs!(english, "settings.import_importing")
                    } else {
                        trs!(english, "settings.migration_commit")
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !disabled {
                            this.commit_electron_migration(cx);
                        }
                    })),
            );
        }
        if let Some(n) = &s.import.migration_notice {
            body = body.child(div().text_size(px(TEXT_XS)).child(n.clone()));
        }
        body.into_any_element()
    }

    fn scan_cc_switch(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.cc_switch_busy {
            return;
        }
        s.cc_switch_busy = true;
        s.cc_switch_selected.clear();
        let owner = s.search.entity_id();
        let call = b.call::<ProviderCcSwitchScan>(Empty {});
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner)
                {
                    s.cc_switch_busy = false;
                    match result {
                        Ok(scan) => s.cc_switch = Some(scan),
                        Err(e) => s.notice = Some(e.to_string()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn import_cc_switch(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.cc_switch_busy || s.cc_switch_selected.is_empty() {
            return;
        }
        let ids = s.cc_switch_selected.iter().cloned().collect();
        s.cc_switch_busy = true;
        let owner = s.search.entity_id();
        let call = b.call::<ProviderCcSwitchImport>(ProviderCcSwitchImportParams { ids });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner)
                {
                    s.cc_switch_busy = false;
                    match result {
                        Ok(r) => {
                            s.providers = Some(r.providers);
                            s.cc_switch = None;
                            s.cc_switch_selected.clear();
                            s.notice = None;
                            s.success = Some(trs!(english, "settings.cc_done").into());
                        }
                        Err(e) => s.notice = Some(e.to_string()),
                    }
                }
                this.refresh_models(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn cc_switch_pane(&self, s: &SettingsState, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.english();
        let busy = s.cc_switch_busy;
        let mut body = card(p)
            .p(px(16.))
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(trs!(english, "settings.cc_title")),
            )
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(trs!(english, "settings.cc_desc")),
            )
            .child(
                outline_button("scan-cc-switch", p)
                    .when(busy, |d| d.opacity(0.5))
                    .child(if busy {
                        trs!(english, "settings.reading")
                    } else {
                        trs!(english, "settings.migration_scan")
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !busy {
                            this.scan_cc_switch(cx);
                        }
                    })),
            );
        if let Some(scan) = &s.cc_switch {
            body = body.child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(scan.path.clone()),
            );
            if scan.candidates.is_empty() {
                body = body.child(
                    div()
                        .text_size(px(TEXT_XS))
                        .child(trs!(english, "settings.cc_empty")),
                );
            }
            for c in &scan.candidates {
                let id = c.id.clone();
                let can_import = c.importable && !busy;
                body = body.child(
                    outline_button(SharedString::from(format!("cc-candidate-{}", c.id)), p)
                        .when(!can_import, |d| d.opacity(0.5))
                        .child(checkbox(s.cc_switch_selected.contains(&c.id), p))
                        .child(format!("{} · {} · {}", c.name, c.app_label, c.model_count))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if can_import
                                && let Some(s) = &mut this.settings
                                && !s.cc_switch_selected.remove(&id)
                            {
                                s.cc_switch_selected.insert(id.clone());
                            }
                            cx.notify();
                        })),
                );
                if let Some(reason) = &c.reason {
                    body = body.child(div().text_size(px(TEXT_XS)).muted(p).child(reason.clone()));
                }
            }
            let disabled = busy || s.cc_switch_selected.is_empty();
            body = body.child(
                outline_button("import-cc-switch", p)
                    .when(disabled, |d| d.opacity(0.5))
                    .child(trs!(english, "settings.cc_import"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !disabled {
                            this.import_cc_switch(cx);
                        }
                    })),
            );
        }
        body.into_any_element()
    }

    fn load_project_defaults(&mut self, path: String, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.project_defaults_busy {
            return;
        }
        s.project_defaults = None;
        s.project_defaults_request = s.project_defaults_request.wrapping_add(1);
        let request = s.project_defaults_request;
        let owner = s.search.entity_id();
        let call = b.call::<ProjectModelDefaultsGet>(ProjectPathParams { path: path.clone() });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner)
                {
                    if s.project_defaults_request != request {
                        return;
                    }
                    match result {
                        Ok(d) => s.project_defaults = Some((path, d)),
                        Err(e) => s.notice = Some(e.to_string()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_project_defaults(
        &mut self,
        path: String,
        defaults: ModelDefaults,
        cx: &mut Context<Self>,
    ) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.project_defaults_busy {
            return;
        }
        s.project_defaults_busy = true;
        s.project_defaults_request = s.project_defaults_request.wrapping_add(1);
        let request = s.project_defaults_request;
        let owner = s.search.entity_id();
        s.notice = None;
        s.success = Some(
            trs!(
                self.app_settings.language == UiLanguage::English,
                "settings.saving"
            )
            .into(),
        );
        let call = b.call::<ProjectModelDefaultsSet>(ProjectModelDefaultsSetParams {
            path: path.clone(),
            defaults,
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(s) = this.settings.as_mut().filter(|s| {
                    s.search.entity_id() == owner && s.project_defaults_request == request
                }) {
                    s.project_defaults_busy = false;
                    match result {
                        Ok(d) => {
                            s.project_defaults = Some((path, d));
                            s.success = Some(trs!(english, "settings.saved").into());
                        }
                        Err(e) => s.notice = Some(e.to_string()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn project_defaults_pane(
        &self,
        s: &SettingsState,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let english = self.english();
        let mut body = card(p)
            .p(px(16.))
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(trs!(english, "settings.project_defaults_title")),
            )
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(trs!(english, "settings.project_defaults_desc")),
            );
        if self.projects.is_empty() {
            body = body.child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(trs!(english, "settings.project_defaults_empty")),
            );
        }
        for project in &self.projects {
            let path = project.path.clone();
            body = body.child(
                outline_button(SharedString::from(format!("project-defaults-{}", path)), p)
                    .child(project.name.clone())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.load_project_defaults(path.clone(), cx)
                    })),
            );
        }
        if let Some((path, defaults)) = &s.project_defaults {
            body = body.child(div().text_size(px(TEXT_XS)).muted(p).child(path.clone()));
            let reset_path = path.clone();
            body = body.child(
                outline_button("project-defaults-inherit", p)
                    .child(trs!(english, "settings.project_defaults_inherit"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.save_project_defaults(reset_path.clone(), ModelDefaults::default(), cx)
                    })),
            );
            for entry in &self.models {
                let path = path.clone();
                let model = entry.label.clone();
                let thinking = defaults.thinking;
                body = body.child(
                    outline_button(
                        SharedString::from(format!("project-model-{}", entry.label)),
                        p,
                    )
                    .child(checkbox(defaults.model.as_ref() == Some(&entry.label), p))
                    .child(format!("{} / {}", entry.provider_name, entry.model.id))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.save_project_defaults(
                            path.clone(),
                            ModelDefaults {
                                model: Some(model.clone()),
                                thinking,
                            },
                            cx,
                        )
                    })),
                );
            }
            for level in std::iter::once(None).chain(LEVELS.map(Some)) {
                let path = path.clone();
                let model = defaults.model.clone();
                let label = level
                    .map(|l| thinking_label_in(l, english))
                    .unwrap_or(trs!(english, "settings.follow_model_default"));
                body = body.child(
                    outline_button(SharedString::from(format!("project-thinking-{level:?}")), p)
                        .child(checkbox(defaults.thinking == level, p))
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.save_project_defaults(
                                path.clone(),
                                ModelDefaults {
                                    model: model.clone(),
                                    thinking: level,
                                },
                                cx,
                            )
                        })),
                );
            }
        }
        body.into_any_element()
    }
}
