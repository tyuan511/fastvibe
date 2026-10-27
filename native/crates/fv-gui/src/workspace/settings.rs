//! Protocol-backed settings: providers, general preferences, personalization, archived chats,
//! skills, MCP, memory, browser, proxy, computer control and import previews are connected.
//! Remote and SSH sections remain reserved for the redesigned remote phase.

use std::collections::HashSet;

use fv_protocol::methods::*;
use fv_protocol::types::Empty;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::component::Sizable as _;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::composer::thinking_label;
use super::sidebar::{INSET, SIDEBAR_WIDTH};
use super::{Workspace, text};
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon, icon_button_xs};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    General,
    Personalization,
    Shortcuts,
    Archived,
    Usage,
    Import,
    Providers,
    Subagents,
    Memory,
    Mcp,
    Skills,
    Computer,
    Browser,
    Proxy,
    Remote,
    Ssh,
    About,
}

/// One pane in the list: which, its label, its icon.
type SectionItem = (Section, &'static str, &'static str);

/// `SETTINGS_SECTIONS`: groups, then each pane's label and icon.
const SECTIONS: &[(&str, &[SectionItem])] = &[
    (
        "偏好设置",
        &[
            (Section::General, "偏好设置", "settings02"),
            (Section::Personalization, "个性化", "sparkles"),
            (Section::Shortcuts, "快捷键", "keyboard"),
        ],
    ),
    (
        "工作区与数据",
        &[
            (Section::Archived, "归档对话", "archive04"),
            (Section::Usage, "使用统计", "analytics01"),
            (Section::Import, "导入", "import"),
        ],
    ),
    (
        "模型与扩展",
        &[
            (Section::Providers, "模型与默认", "boxes"),
            (Section::Subagents, "子 Agent", "bot"),
            (Section::Memory, "长期记忆", "sticky-note01"),
            (Section::Mcp, "MCP 工具", "plug01"),
            (Section::Skills, "技能", "sparkles"),
        ],
    ),
    (
        "系统",
        &[
            (Section::Computer, "电脑操控", "computer"),
            (Section::Browser, "浏览器控制", "globe02"),
            (Section::Proxy, "网络代理", "router01"),
            (Section::Remote, "远程访问", "wifi01"),
            (Section::Ssh, "SSH 远程主机", "server-stack01"),
        ],
    ),
    ("关于", &[(Section::About, "关于", "information-circle")]),
];

fn section_label(section: Section) -> &'static str {
    SECTIONS
        .iter()
        .flat_map(|(_, items)| items.iter())
        .find(|(s, _, _)| *s == section)
        .map(|(_, l, _)| *l)
        .unwrap_or("")
}

fn section_label_for(section: Section, language: UiLanguage) -> &'static str {
    if language == UiLanguage::Chinese {
        return section_label(section);
    }
    match section {
        Section::General => "Preferences",
        Section::Personalization => "Personalization",
        Section::Shortcuts => "Shortcuts",
        Section::Archived => "Archived chats",
        Section::Usage => "Usage",
        Section::Import => "Import",
        Section::Providers => "Models & defaults",
        Section::Subagents => "Subagents",
        Section::Memory => "Long-term memory",
        Section::Mcp => "MCP tools",
        Section::Skills => "Skills",
        Section::Computer => "Computer control",
        Section::Browser => "Browser control",
        Section::Proxy => "Network proxy",
        Section::Remote => "Remote access",
        Section::Ssh => "SSH hosts",
        Section::About => "About",
    }
}

fn section_group_label(group: &str, language: UiLanguage) -> &'static str {
    if language == UiLanguage::Chinese {
        return match group {
            "偏好设置" => "偏好设置",
            "工作区与数据" => "工作区与数据",
            "模型与扩展" => "模型与扩展",
            "系统" => "系统",
            "关于" => "关于",
            _ => "Settings",
        };
    }
    match group {
        "偏好设置" => "Preferences",
        "工作区与数据" => "Workspace & data",
        "模型与扩展" => "Models & extensions",
        "系统" => "System",
        "关于" => "About",
        _ => "Settings",
    }
}

pub fn protocol_label(p: ApiProtocol) -> &'static str {
    match p {
        ApiProtocol::Chat => "OpenAI Chat Completions (/chat/completions)",
        ApiProtocol::Responses => "OpenAI Responses (/responses)",
        ApiProtocol::Anthropic => "Anthropic Messages (/v1/messages)",
        ApiProtocol::Google => "Google Generative AI",
    }
}

const PROTOCOLS: [ApiProtocol; 4] = [
    ApiProtocol::Chat,
    ApiProtocol::Responses,
    ApiProtocol::Anthropic,
    ApiProtocol::Google,
];

const LEVELS: [ThinkingLevel; 6] = [
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::Xhigh,
    ThinkingLevel::Max,
];

/// The open provider's editable fields.
pub struct ProviderEdit {
    pub clear_key_after_save: Option<String>,
    pub id: String,
    pub base_url: Entity<InputState>,
    pub key: Entity<InputState>,
    pub protocol_menu: bool,
}

/// Models offered by a provider, to tick before they are added.
pub struct Picker {
    /// `None` while the list is being fetched.
    pub models: Option<Vec<ModelInfo>>,
    pub chosen: HashSet<String>,
    pub error: Option<String>,
    pub search: Entity<InputState>,
}

/// 添加供应商: the form, then the models it offers.
pub struct AddProvider {
    pub name: Entity<InputState>,
    pub base_url: Entity<InputState>,
    pub key: Entity<InputState>,
    pub protocol: ApiProtocol,
    pub protocol_menu: bool,
    pub busy: bool,
    pub error: Option<String>,
    pub picker: Option<Picker>,
}

/// 管理模型: the models a saved provider offers, to add more of them.
pub struct AddModels {
    pub busy: bool,
    pub provider_id: String,
    pub picker: Picker,
}

pub struct BrowserSettings {
    pub homepage: Entity<InputState>,
    pub search_engine: Entity<InputState>,
    pub download_dir: Entity<InputState>,
}

pub struct ProxySettings {
    pub url: Entity<InputState>,
}

#[derive(Default)]
pub struct ImportSettings {
    pub generation: u64,
    pub candidates: Option<Vec<ImportCandidate>>,
    pub preview: Option<ImportReadResponse>,
    pub busy: bool,
    pub notice: Option<String>,
}

impl ProxySettings {
    fn new(settings: &AppSettings, window: &mut Window, cx: &mut App) -> Self {
        let url = input(window, cx, "留空使用系统网络设置", false);
        url.update(cx, |state, cx| {
            state.set_value(settings.proxy_url.clone(), window, cx)
        });
        Self { url }
    }
}

impl BrowserSettings {
    fn new(settings: &AppSettings, window: &mut Window, cx: &mut App) -> Self {
        Self {
            homepage: input(window, cx, "about:blank 或 https://…", false),
            search_engine: input(window, cx, "https://…/?q={query}", false),
            download_dir: input(window, cx, "留空使用 ~/Downloads", false),
        }
        .with_values(settings, window, cx)
    }

    fn with_values(self, settings: &AppSettings, window: &mut Window, cx: &mut App) -> Self {
        self.homepage.update(cx, |state, cx| {
            state.set_value(settings.browser_homepage.clone(), window, cx)
        });
        self.search_engine.update(cx, |state, cx| {
            state.set_value(settings.browser_search_engine.clone(), window, cx)
        });
        self.download_dir.update(cx, |state, cx| {
            state.set_value(settings.browser_download_dir.clone(), window, cx)
        });
        self
    }
}

/// Which 外观 list is open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeMenu {
    Language,
    Mode,
    Light,
    Dark,
    Sandbox,
    Approval,
}

pub struct SettingsState {
    pub model_checks: super::provider_test::ModelChecks,
    pub model_edit: Option<super::model_detail::ModelEditor>,
    pub provider_request: u64,
    pub about: super::about::AboutSettings,
    pub usage: super::usage::UsageSettings,
    pub shortcuts: super::shortcuts::ShortcutSettings,
    pub personalization: super::personalization::PersonalizationSettings,
    pub memory: super::memory::MemorySettings,
    pub mcp: super::mcp::McpSettings,
    pub skills: super::skills::SkillSettings,
    pub browser: BrowserSettings,
    pub proxy: ProxySettings,
    pub import: ImportSettings,
    pub theme_menu: Option<ThemeMenu>,
    /// 归档对话: what the sidebar leaves out.
    pub archived: Option<Vec<Thread>>,
    /// The archived thread asked to be deleted, until the user confirms.
    pub confirm_delete: Option<ThreadId>,
    pub section: Section,
    pub providers: Option<Vec<ProviderInfo>>,
    pub edit: Option<ProviderEdit>,
    pub default_menu: bool,
    pub search: Entity<InputState>,
    pub add: Option<AddProvider>,
    pub add_models: Option<AddModels>,
    pub notice: Option<String>,
}

fn input(window: &mut Window, cx: &mut App, placeholder: &str, masked: bool) -> Entity<InputState> {
    let placeholder = SharedString::from(placeholder.to_string());
    cx.new(|cx| {
        InputState::new(window, cx)
            .placeholder(placeholder)
            .masked(masked)
    })
}

fn value(state: &Entity<InputState>, cx: &App) -> String {
    state.read(cx).value().trim().to_string()
}

impl Workspace {
    pub(super) fn sync_provider_key_clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(edit) = self.settings.as_mut().and_then(|s| s.edit.as_mut()) else {
            return;
        };
        let Some(submitted) = edit.clear_key_after_save.take() else {
            return;
        };
        if edit.key.read(cx).value().as_ref() == submitted {
            edit.key
                .update(cx, |input, cx| input.set_value("", window, cx));
        }
    }

    // ---- opening and closing

    pub(super) fn open_settings(
        &mut self,
        section: Section,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_none() {
            self.settings = Some(SettingsState {
                model_checks: Default::default(),
                model_edit: None,
                provider_request: 0,
                about: Default::default(),
                usage: Default::default(),
                shortcuts: super::shortcuts::ShortcutSettings::new(window, cx),
                personalization: super::personalization::PersonalizationSettings::new(
                    &self.app_settings.custom_system_prompt,
                    window,
                    cx,
                ),
                memory: Default::default(),
                mcp: super::mcp::McpSettings::new(window, cx),
                skills: super::skills::SkillSettings::new(window, cx),
                browser: BrowserSettings::new(&self.app_settings, window, cx),
                proxy: ProxySettings::new(&self.app_settings, window, cx),
                import: ImportSettings::default(),
                section,
                providers: None,
                edit: None,
                default_menu: false,
                theme_menu: None,
                archived: None,
                confirm_delete: None,
                search: input(window, cx, "搜索供应商或模型", false),
                add: None,
                add_models: None,
                notice: None,
            });
            self.subscribe_personalization(window, cx);
            self.subscribe_shortcuts(window, cx);
            let query = self.settings.as_ref().unwrap().skills.query.clone();
            cx.subscribe_in(
                &query,
                window,
                |_, _, event: &gpui_kit::component::input::InputEvent, _, cx| {
                    if matches!(event, gpui_kit::component::input::InputEvent::Change) {
                        cx.notify();
                    }
                },
            )
            .detach();
        }
        if let Some(s) = &mut self.settings {
            if s.section != section {
                s.shortcuts.cancel();
                s.model_checks.invalidate();
            }
            s.section = section;
        }
        self.model_menu = false;
        self.project_menu = false;
        self.refresh_providers(cx);
        self.refresh_models(cx);
        self.refresh_archived(cx);
        self.refresh_skills(cx);
        self.refresh_mcp(cx);
        self.refresh_memory(cx);
        self.refresh_usage(cx);
        self.refresh_import(cx);
        self.refresh_about(cx);
        self.refresh_subagents(cx);
        self.refresh_roles(cx);
        cx.notify();
    }

    pub(super) fn refresh_archived(&mut self, cx: &mut Context<Self>) {
        if self.settings.is_none() {
            return;
        }
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<ThreadList>(ThreadListParams {
            include_archived: true,
        });
        cx.spawn(async move |this, cx| {
            if let Ok(r) = call.await {
                this.update(cx, |this, cx| {
                    if let Some(s) = &mut this.settings {
                        s.archived = Some(r.threads.into_iter().filter(|t| t.archived).collect());
                    }
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn refresh_import(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(settings) = self.settings.as_mut() else {
            return;
        };
        settings.import.generation = settings.import.generation.wrapping_add(1);
        let generation = settings.import.generation;
        settings.import.busy = true;
        settings.import.notice = None;
        let call = backend.call::<ImportScan>(ImportScanParams { source: None });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Some(settings) = this
                    .settings
                    .as_mut()
                    .filter(|settings| settings.import.generation == generation)
                {
                    settings.import.busy = false;
                    match result {
                        Ok(response) => settings.import.candidates = Some(response.candidates),
                        Err(error) => {
                            settings.import.notice = Some(format!("读取导入候选失败：{error}"))
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn preview_import(&mut self, candidate: ImportCandidate, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(settings) = self.settings.as_mut() else {
            return;
        };
        settings.import.generation = settings.import.generation.wrapping_add(1);
        let generation = settings.import.generation;
        settings.import.busy = true;
        settings.import.preview = None;
        settings.import.notice = None;
        let call = backend.call::<ImportRead>(ImportReadParams {
            source: candidate.source,
            source_id: candidate.source_id,
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Some(settings) = this
                    .settings
                    .as_mut()
                    .filter(|settings| settings.import.generation == generation)
                {
                    settings.import.busy = false;
                    match result {
                        Ok(response) => settings.import.preview = Some(response),
                        Err(error) => {
                            settings.import.notice = Some(format!("读取导入预览失败：{error}"))
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn commit_import(&mut self, candidate: ImportCandidate, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(settings) = self.settings.as_mut() else {
            return;
        };
        settings.import.busy = true;
        settings.import.notice = None;
        let call = backend.call::<ImportCommit>(ImportCommitParams {
            source: candidate.source,
            source_id: candidate.source_id,
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(response) => {
                        let thread_id = response.thread.id.clone();
                        this.settings = None;
                        this.refresh_threads(cx);
                        this.select(thread_id, cx);
                    }
                    Err(error) => {
                        if let Some(settings) = &mut this.settings {
                            settings.import.busy = false;
                            settings.import.notice = Some(format!("导入失败：{error}"));
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(super) fn refresh_providers(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            if let Some(s) = &mut self.settings
                && s.providers.is_none()
            {
                s.providers = Some(Vec::new());
            }
            return;
        };
        let Some(s) = &mut self.settings else {
            return;
        };
        s.provider_request = s.provider_request.wrapping_add(1);
        let (owner, request) = (s.search.entity_id(), s.provider_request);
        let call = b.call::<ProviderList>(Empty {});
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner && s.provider_request == request)
                {
                    match result {
                        Ok(r) => s.providers = Some(r.providers),
                        Err(e) => s.notice = Some(format!("读取供应商失败：{e}")),
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Save a provider as it is now, with `change` applied; the key is kept unless given.
    fn save_provider(
        &mut self,
        id: &str,
        api_key: Option<String>,
        change: impl FnOnce(&mut ProviderUpsertParams),
        cx: &mut Context<Self>,
    ) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(p) = self
            .settings
            .as_ref()
            .and_then(|s| s.providers.as_ref())
            .and_then(|list| list.iter().find(|p| p.id == id))
        else {
            return;
        };
        let mut params = ProviderUpsertParams {
            expected: Some(p.clone()),
            id: Some(p.id.clone()),
            name: p.name.clone(),
            protocol: p.protocol,
            base_url: p.base_url.clone(),
            api_key,
            enabled: p.enabled,
            models: p.models.clone(),
        };
        change(&mut params);
        let owner = self.settings.as_ref().map(|s| s.search.entity_id());
        let key_draft = params.api_key.as_ref().and_then(|key| {
            self.settings
                .as_ref()
                .and_then(|s| s.edit.as_ref())
                .filter(|e| e.id == params.id.as_deref().unwrap_or(""))
                .and_then(|e| {
                    let raw = e.key.read(cx).value().to_string();
                    (raw.trim() == key).then_some((e.key.entity_id(), raw))
                })
        });
        let call = b.call::<ProviderUpsert>(params);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| Some(s.search.entity_id()) == owner)
                {
                    match result {
                        Ok(_) => {
                            if let Some((key_owner, raw)) = key_draft
                                && let Some(edit) =
                                    s.edit.as_mut().filter(|e| e.key.entity_id() == key_owner)
                            {
                                edit.clear_key_after_save = Some(raw);
                            }
                        }
                        Err(e) => s.notice = Some(format!("保存失败：{e}")),
                    }
                }
                this.refresh_providers(cx);
                this.refresh_models(cx);
            })
            .ok();
        })
        .detach();
    }

    fn delete_provider(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<ProviderDelete>(ProviderIdParams { provider_id: id });
        cx.spawn(async move |this, cx| {
            let _ = call.await;
            this.update(cx, |this, cx| {
                if let Some(s) = &mut this.settings {
                    s.edit = None;
                }
                this.refresh_providers(cx);
                this.refresh_models(cx);
            })
            .ok();
        })
        .detach();
    }

    fn set_default(&mut self, defaults: ModelDefaults, cx: &mut Context<Self>) {
        self.defaults = defaults.clone();
        if let Some(s) = &mut self.settings {
            s.default_menu = false;
        }
        cx.notify();
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<ModelDefaultsSet>(defaults);
        cx.spawn(async move |this, cx| {
            if let Ok(d) = call.await {
                this.update(cx, |this, cx| {
                    this.defaults = d;
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn toggle_provider(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.invalidate_provider_checks();
        let Some(s) = &mut self.settings else { return };
        if s.edit.as_ref().is_some_and(|e| e.id == id) {
            s.edit = None;
            cx.notify();
            return;
        }
        let Some(p) = s
            .providers
            .as_ref()
            .and_then(|l| l.iter().find(|p| p.id == id))
            .cloned()
        else {
            return;
        };
        let base_url = input(window, cx, "https://api.example.com/v1", false);
        base_url.update(cx, |st, cx| st.set_value(p.base_url.clone(), window, cx));
        let key = input(
            window,
            cx,
            if p.has_key {
                "已保存，输入新密钥可更新"
            } else {
                "粘贴 API 密钥"
            },
            true,
        );
        if let Some(s) = &mut self.settings {
            s.edit = Some(ProviderEdit {
                clear_key_after_save: None,
                id,
                base_url,
                key,
                protocol_menu: false,
            });
        }
        cx.notify();
    }

    fn fetch_into(
        &mut self,
        params: FetchModelsParams,
        target: impl Fn(&mut SettingsState) -> Option<&mut Picker> + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(owner) = self
            .settings
            .as_mut()
            .and_then(&target)
            .map(|p| p.search.entity_id())
        else {
            return;
        };
        let Some(b) = self.backend.clone() else {
            if let Some(picker) = self.settings.as_mut().and_then(&target) {
                picker.models = Some(Vec::new());
                picker.error = Some("还没有连上服务，稍后再试。".to_string());
            }
            if let Some(a) = self.settings.as_mut().and_then(|s| s.add.as_mut()) {
                a.busy = false;
            }
            cx.notify();
            return;
        };
        let call = b.call::<ProviderFetchModels>(params);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Some(s) = &mut this.settings {
                    let is_add = s
                        .add
                        .as_ref()
                        .and_then(|a| a.picker.as_ref())
                        .is_some_and(|p| p.search.entity_id() == owner);
                    if let Some(picker) = target(s).filter(|p| p.search.entity_id() == owner) {
                        match result {
                            Ok(r) => picker.models = Some(r.models),
                            Err(e) => {
                                picker.models = Some(Vec::new());
                                picker.error = Some(format!("无法拉取模型列表：{e}"));
                            }
                        }
                    } else {
                        return;
                    }
                    if is_add && let Some(a) = &mut s.add {
                        a.busy = false;
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn open_add_models(
        &mut self,
        provider_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let search = input(window, cx, "搜索模型", false);
        let Some(s) = &mut self.settings else { return };
        let chosen = s
            .providers
            .as_ref()
            .and_then(|l| l.iter().find(|p| p.id == provider_id))
            .map(|p| p.models.iter().map(|m| m.id.clone()).collect())
            .unwrap_or_default();
        s.add_models = Some(AddModels {
            busy: false,
            provider_id: provider_id.clone(),
            picker: Picker {
                models: None,
                chosen,
                error: None,
                search,
            },
        });
        cx.notify();
        self.fetch_into(
            FetchModelsParams {
                provider_id: Some(provider_id),
                protocol: None,
                base_url: None,
                api_key: None,
            },
            |s| s.add_models.as_mut().map(|a| &mut a.picker),
            cx,
        );
    }

    pub(super) fn open_add_provider(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let add = AddProvider {
            name: input(window, cx, "例如 OpenRouter", false),
            base_url: input(window, cx, "https://api.example.com/v1", false),
            key: input(window, cx, "粘贴该供应商的 API 密钥", true),
            protocol: ApiProtocol::Chat,
            protocol_menu: false,
            busy: false,
            error: None,
            picker: None,
        };
        if let Some(s) = &mut self.settings {
            s.add = Some(add);
        }
        cx.notify();
    }

    /// 确认 on the form: check it, then ask the provider for its models.
    fn confirm_add_provider(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(a) = self.settings.as_ref().and_then(|s| s.add.as_ref()) else {
            return;
        };
        let key = value(&a.key, cx);
        let (protocol, base_url) = (a.protocol, value(&a.base_url, cx));
        if value(&a.name, cx).is_empty() || base_url.is_empty() || key.is_empty() {
            self.add_error("请填写名称、Base URL 与 API 密钥", cx);
            return;
        }
        let search = input(window, cx, "搜索模型", false);
        if let Some(a) = self.settings.as_mut().and_then(|s| s.add.as_mut()) {
            a.busy = true;
            a.error = None;
            a.picker = Some(Picker {
                models: None,
                chosen: HashSet::new(),
                error: None,
                search,
            });
        }
        cx.notify();
        self.fetch_into(
            FetchModelsParams {
                provider_id: None,
                protocol: Some(protocol),
                base_url: Some(base_url),
                api_key: Some(key),
            },
            |s| s.add.as_mut().and_then(|a| a.picker.as_mut()),
            cx,
        );
    }

    fn add_error(&mut self, message: &str, cx: &mut Context<Self>) {
        if let Some(a) = self.settings.as_mut().and_then(|s| s.add.as_mut()) {
            a.error = Some(message.to_string());
        }
        cx.notify();
    }

    /// 添加 N 个模型: save the new provider with the ticked models.
    fn finish_add_provider(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            self.add_error("还没有连上服务，稍后再试。", cx);
            return;
        };
        let Some(a) = self.settings.as_ref().and_then(|s| s.add.as_ref()) else {
            return;
        };
        if a.busy {
            return;
        }
        let owner = a.name.entity_id();
        let Some(picker) = &a.picker else { return };
        let models: Vec<ModelInfo> = picker
            .models
            .iter()
            .flatten()
            .filter(|m| picker.chosen.contains(&m.id))
            .cloned()
            .collect();
        if models.is_empty() {
            self.add_error("至少选择一个模型", cx);
            return;
        }
        let (name, protocol, base_url) = (value(&a.name, cx), a.protocol, value(&a.base_url, cx));
        let first = models[0].id.clone();
        let call = b.call::<ProviderUpsert>(ProviderUpsertParams {
            expected: None,
            id: None,
            name,
            protocol,
            base_url,
            api_key: Some(value(&a.key, cx)),
            enabled: true,
            models,
        });
        let had_default = self.defaults.model.is_some();
        if let Some(a) = self.settings.as_mut().and_then(|s| s.add.as_mut()) {
            a.busy = true;
        }
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(r) => {
                        if let Some(s) = &mut this.settings
                            && s.add.as_ref().is_some_and(|a| a.name.entity_id() == owner)
                        {
                            s.add = None;
                        }
                        // The first provider's first model becomes the default, so the very
                        // next message has somewhere to go.
                        if !had_default && this.defaults.model.is_none() {
                            let label = format!("{}/{}", r.provider.id, first);
                            let thinking = this.defaults.thinking;
                            this.set_default(
                                ModelDefaults {
                                    model: Some(label),
                                    thinking,
                                },
                                cx,
                            );
                        }
                    }
                    Err(e) => {
                        if let Some(a) = this
                            .settings
                            .as_mut()
                            .and_then(|s| s.add.as_mut())
                            .filter(|a| a.name.entity_id() == owner)
                        {
                            a.busy = false;
                            a.error = Some(format!("保存失败：{e}"));
                        }
                    }
                }
                this.refresh_providers(cx);
                this.refresh_models(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn finish_add_models(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        let Some(am) = s.add_models.as_mut().filter(|a| !a.busy) else {
            return;
        };
        let Some(provider) = s
            .providers
            .as_ref()
            .and_then(|v| v.iter().find(|p| p.id == am.provider_id))
        else {
            return;
        };
        let owner = am.picker.search.entity_id();
        let chosen = am.picker.chosen.clone();
        let fetched = am.picker.models.clone().unwrap_or_default();
        let call = b.call::<ProviderUpsert>(ProviderUpsertParams {
            id: Some(provider.id.clone()),
            name: provider.name.clone(),
            protocol: provider.protocol,
            base_url: provider.base_url.clone(),
            api_key: None,
            enabled: provider.enabled,
            models: super::model_detail::merge_models(&provider.models, &fetched, &chosen),
            expected: Some(provider.clone()),
        });
        am.busy = true;
        am.picker.error = None;
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Some(s) = this.settings.as_mut()
                    && let Some(am) = s
                        .add_models
                        .as_mut()
                        .filter(|a| a.picker.search.entity_id() == owner)
                {
                    am.busy = false;
                    match result {
                        Ok(_) => {
                            if am.picker.chosen == chosen {
                                s.add_models = None;
                            }
                        }
                        Err(error) => {
                            am.picker.error = Some(format!("保存失败，选择已保留：{error}"))
                        }
                    }
                }
                this.refresh_providers(cx);
                this.refresh_models(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    // ---- drawing

    pub(super) fn settings_view(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let Some(s) = &self.settings else {
            return div().into_any_element();
        };
        div()
            .size_full()
            .flex()
            .child(self.settings_nav(s, cx))
            .child(
                div()
                    .id("settings-body")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .overflow_y_scroll()
                    .child(
                        div()
                            .w_full()
                            .max_w(px(768.0))
                            .mx_auto()
                            .px(px(16.0))
                            .pt(px(32.0))
                            .pb(px(48.0))
                            .flex()
                            .flex_col()
                            .gap(px(20.0))
                            .child(
                                div()
                                    .text_size(px(20.0))
                                    .line_height(px(28.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(section_label_for(
                                        s.section,
                                        self.app_settings.language,
                                    )),
                            )
                            .child(match s.section {
                                Section::Providers => {
                                    self.providers_pane(s, window, cx).into_any_element()
                                }
                                Section::General => self.general_pane(s, cx).into_any_element(),
                                Section::Personalization => self.personalization_pane(cx),
                                Section::Shortcuts => self.shortcuts_pane(cx),
                                Section::About => self.about_pane(cx),
                                Section::Usage => self.usage_pane(cx),
                                Section::Archived => self.archived_pane(s, cx).into_any_element(),
                                Section::Import => self.import_pane(s, cx),
                                Section::Skills => self.skills_pane(cx),
                                Section::Mcp => self.mcp_pane(cx),
                                Section::Subagents => self.subagents_pane(cx),
                                Section::Memory => self.memory_pane(cx),
                                Section::Browser => self.browser_pane(s, cx),
                                Section::Computer => self.computer_pane(cx),
                                Section::Proxy => self.proxy_pane(s, cx),
                                _ => self.not_yet().into_any_element(),
                            }),
                    ),
            )
            .into_any_element()
    }

    fn settings_nav(&self, s: &SettingsState, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let language = self.app_settings.language;
        let hover = ui::half(p.c(Token::SidebarAccent));
        let mut list = div().px(px(8.0)).pb(px(12.0)).flex().flex_col();
        for (gi, (group, items)) in SECTIONS.iter().enumerate() {
            list = list.child(
                div()
                    .when(gi > 0, |d| d.mt(px(12.0)))
                    .pl(px(8.0))
                    .py(px(4.0))
                    .text_size(px(TEXT_XS))
                    .font_weight(FontWeight::MEDIUM)
                    .muted(p)
                    .child(section_group_label(group, language)),
            );
            for (section, label, glyph) in items.iter() {
                let section = *section;
                let active = s.section == section;
                list = list.child(
                    div()
                        .id(SharedString::from(format!("settings-{label}")))
                        .h(px(32.0))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .rounded(px(8.0))
                        .cursor_pointer()
                        .text_size(px(TEXT_SM))
                        .map(|d| {
                            if active {
                                d.bg(p.c(Token::SidebarAccent))
                                    .font_weight(FontWeight::MEDIUM)
                            } else {
                                d.hover(move |d| d.bg(hover))
                            }
                        })
                        .child(icon(glyph, 14.0, p.c(Token::MutedForeground)))
                        .child(section_label_for(section, language))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_settings(section, window, cx)
                        })),
                );
            }
        }
        div()
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .flex_none()
            .p(px(INSET))
            .child(
                div()
                    .relative()
                    .size_full()
                    .rounded(px(16.0))
                    .bg(p.pane())
                    .text_color(p.c(Token::SidebarForeground))
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .child(div().h(px(44.0)).flex_none())
                    .child(
                        div().px(px(8.0)).flex_none().child(
                            div()
                                .id("back-to-app")
                                .h(px(32.0))
                                .px(px(8.0))
                                .flex()
                                .items_center()
                                .gap(px(10.0))
                                .rounded(px(8.0))
                                .cursor_pointer()
                                .text_size(px(TEXT_SM))
                                .hover(move |d| d.bg(hover))
                                .child(icon("arrow-left01", 14.0, p.c(Token::MutedForeground)))
                                .child(if language == UiLanguage::English {
                                    "Back to app"
                                } else {
                                    "返回应用"
                                })
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.settings = None;
                                    cx.notify();
                                })),
                        ),
                    )
                    .child(
                        div()
                            .id("settings-nav")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .pt(px(4.0))
                            .child(list),
                    )
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded(px(16.0))
                            .border_1()
                            .border_color(p.c(Token::SidebarBorder)),
                    ),
            )
    }

    fn import_pane(&self, s: &SettingsState, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let open_skills =
            cx.listener(|this, _, window, cx| this.open_settings(Section::Skills, window, cx));
        let open_mcp =
            cx.listener(|this, _, window, cx| this.open_settings(Section::Mcp, window, cx));
        let refresh = cx.listener(|this, _, _, cx| this.refresh_import(cx));
        let mut claude = card(p)
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_size(px(TEXT_SM)).child(if english { "Other Agent sessions" } else { "其它 Agent 会话" }))
                    .child(
                        outline_button("refresh-import-candidates", p)
                            .child(if s.import.busy {
                                if english { "Reading…" } else { "读取中…" }
                            } else {
                                if english { "Refresh" } else { "刷新" }
                            })
                            .on_click(refresh),
                    ),
            )
            .child(div().text_size(px(TEXT_XS)).muted(p).child(
                if english { "Scan local Claude Code, pi, Codex, OpenCode, and zcode session files. History is read-only; preview does not write to FastVibe." } else { "扫描本机 Claude Code、pi、Codex、OpenCode 与 zcode 的会话文件，只读显示历史消息，预览不会写入 FastVibe。" },
            ));
        if let Some(notice) = &s.import.notice {
            claude = claude.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(notice.clone()),
            );
        }
        match &s.import.candidates {
            None if s.import.busy => {
                claude = claude.child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                    "Looking for sessions…"
                } else {
                    "正在查找会话…"
                }));
            }
            Some(candidates) if candidates.is_empty() => {
                claude = claude.child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                    "No importable Agent sessions found."
                } else {
                    "没有找到可导入的 Agent 会话。"
                }));
            }
            Some(candidates) => {
                for (index, candidate) in candidates.iter().enumerate() {
                    let selected =
                        s.import.preview.as_ref().is_some_and(|preview| {
                            preview.candidate.source_id == candidate.source_id
                        });
                    let preview_candidate = candidate.clone();
                    claude = claude.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .when(index > 0, |d| {
                                d.border_t_1().border_color(p.c(Token::Border))
                            })
                            .pt(px(if index > 0 { 8. } else { 2. }))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        ui::truncate(format!(
                                            "{} · {}",
                                            candidate.source, candidate.title
                                        ))
                                        .text_size(px(TEXT_SM)),
                                    )
                                    .child(div().text_size(px(TEXT_XS)).muted(p).child(format!(
                                        "{} {} · {}",
                                        candidate.message_count,
                                        if english { "messages" } else { "条消息" },
                                        candidate.cwd.as_deref().unwrap_or(if english {
                                            "Unknown directory"
                                        } else {
                                            "未知目录"
                                        })
                                    ))),
                            )
                            .child(
                                outline_button(
                                    SharedString::from(format!("preview-import-{index}")),
                                    p,
                                )
                                .child(if selected {
                                    if english { "Previewed" } else { "已预览" }
                                } else {
                                    if english { "Preview" } else { "预览" }
                                })
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.preview_import(preview_candidate.clone(), cx)
                                    },
                                )),
                            ),
                    );
                }
            }
            _ => {}
        }
        if let Some(preview) = &s.import.preview {
            let commit_candidate = preview.candidate.clone();
            claude = claude.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(10.))
                    .mt(px(4.))
                    .pt(px(10.))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .text_size(px(TEXT_XS))
                    .child(div().flex_1().child(if english {
                        format!(
                            "Preview: {} engine messages, skipped {} source records.",
                            preview.messages.len(),
                            preview.skipped.len()
                        )
                    } else {
                        format!(
                            "预览：{} 条引擎消息，跳过 {} 条源记录。",
                            preview.messages.len(),
                            preview.skipped.len()
                        )
                    }))
                    .child(
                        outline_button("commit-import", p)
                            .child(if english {
                                "Import as new chat"
                            } else {
                                "导入为新对话"
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.commit_import(commit_candidate.clone(), cx)
                            })),
                    ),
            );
        }
        card(p)
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(div().text_size(px(TEXT_SM)).child(if english { "Import tools and extensions" } else { "导入工具与扩展" }))
            .child(claude)
            .child(
                div().text_size(px(TEXT_SM)).muted(p).child(
                    if english { "Native import entry points are separated by data type so third-party configuration is not written directly into settings." } else { "原生版的导入入口按数据类型分开处理，避免把第三方配置直接写入设置文件。" },
                ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex_1()
                            .child(div().text_size(px(TEXT_SM)).child(if english { "Skills folder" } else { "技能文件夹" }))
                            .child(
                                div()
                                    .text_size(px(TEXT_XS))
                                    .muted(p)
                                    .child(if english { "Import a local SKILL.md and its resources while preserving the source scope." } else { "导入本地 SKILL.md 与附属资源，并保留来源范围。" }),
                            ),
                    )
                    .child(
                        outline_button("open-import-skills", p)
                            .child(if english { "Open skill import" } else { "打开技能导入" })
                            .on_click(open_skills),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex_1()
                            .child(div().text_size(px(TEXT_SM)).child(if english { "MCP configuration" } else { "MCP 配置" }))
                            .child(
                                div()
                                    .text_size(px(TEXT_XS))
                                    .muted(p)
                                    .child(if english { "Paste mcpServers/servers JSON; validate each server before updating the configuration." } else { "粘贴 mcpServers/servers JSON，逐项校验后更新配置。" }),
                            ),
                    )
                    .child(
                        outline_button("open-import-mcp", p)
                            .child(if english { "Open MCP import" } else { "打开 MCP 导入" })
                            .on_click(open_mcp),
                    ),
            )
            .into_any_element()
    }

    fn not_yet(&self) -> impl IntoElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        card(p).child(
            div()
                .px(px(16.0))
                .py(px(24.0))
                .text_size(px(TEXT_SM))
                .muted(p)
                .child(if english {
                    "This page is being ported."
                } else {
                    "这一页还在移植中。"
                }),
        )
    }

    fn save_browser(&mut self, cx: &mut Context<Self>) {
        let Some(s) = self.settings.as_ref() else {
            return;
        };
        let browser = &s.browser;
        self.patch_settings(
            AppSettingsPatch {
                browser_homepage: Some(value(&browser.homepage, cx)),
                browser_search_engine: Some(value(&browser.search_engine, cx)),
                browser_download_dir: Some(value(&browser.download_dir, cx)),
                ..Default::default()
            },
            cx,
        );
    }

    fn browser_pane(&self, s: &SettingsState, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        card(p)
            .p(px(16.0))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(div().text_size(px(TEXT_SM)).child(if english {
                                "Browser control"
                            } else {
                                "浏览器控制"
                            }))
                            .child(
                                div()
                                    .text_size(px(TEXT_XS))
                                    .muted(p)
                                    .child(if english {
                                        "Configure new tabs, address-bar search, and downloads. Pages run in an isolated native WebView."
                                    } else {
                                        "设置新标签页、地址栏搜索和下载位置。网页仍在隔离的原生 WebView 中运行。"
                                    }),
                            ),
                    )
                    .child(
                        outline_button("save-browser-settings", p)
                            .child(if english { "Save" } else { "保存" })
                            .on_click(cx.listener(|this, _, _, cx| this.save_browser(cx))),
                    ),
            )
            .child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                "Home page"
            } else {
                "主页"
            }))
            .child(Input::new(&s.browser.homepage).small())
            .child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                "Search URL template"
            } else {
                "搜索地址模板"
            }))
            .child(Input::new(&s.browser.search_engine).small())
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(if english {
                        "The template must contain {query}, for example https://www.google.com/search?q={query}."
                    } else {
                        "模板必须包含 {query}，例如 https://www.google.com/search?q={query}。"
                    }),
            )
            .child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                "Download directory"
            } else {
                "下载目录"
            }))
            .child(Input::new(&s.browser.download_dir).small())
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(if english {
                        "Leave empty to use the current user's Downloads directory; a value must be an absolute path."
                    } else {
                        "留空使用当前用户的 Downloads 目录；填写时必须是绝对路径。"
                    }),
            )
            .into_any_element()
    }

    fn computer_pane(&self, _cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let supported =
            cfg!(target_os = "macos") || cfg!(target_os = "linux") || cfg!(target_os = "windows");
        card(p)
            .p(px(16.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(div().text_size(px(TEXT_SM)).child(if english {
                "Computer control"
            } else {
                "电脑操控"
            }))
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(if cfg!(target_os = "macos") {
                        if english { "macOS supports screenshots, clicks, text input, and limited keys. Every side-effecting action asks for confirmation first." } else { "macOS 已提供截图、点击、输入和有限按键。每个有副作用的动作都会先请求你的确认。" }
                    } else if cfg!(target_os = "linux") {
                        if english { "Linux uses grim, gnome-screenshot, or scrot for screenshots and xdotool for clicks, text input, and limited keys; every side-effecting action asks for confirmation first." } else { "Linux 使用 grim、gnome-screenshot 或 scrot 截图，并通过 xdotool 执行点击、输入和有限按键；每个有副作用的动作都会先请求你的确认。" }
                    } else if cfg!(target_os = "windows") {
                        if english { "Windows uses PowerShell and system APIs for screenshots, clicks, text input, and limited keys; every side-effecting action asks for confirmation first." } else { "Windows 使用 PowerShell 与系统 API 截图，并执行点击、输入和有限按键；每个有副作用的动作都会先请求你的确认。" }
                    } else {
                        if english { "Computer control is not available on this platform; native tools report unsupported instead of pretending to succeed." } else { "当前平台尚未提供电脑操控；原生工具会明确返回不支持，不会伪造执行成功。" }
                    }),
            )
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(if cfg!(target_os = "macos") {
                        if english { "The first use requires FastVibe to be allowed in System Settings → Privacy & Security → Accessibility; denied permission returns a readable error." } else { "首次使用需要在系统设置 → 隐私与安全性 → 辅助功能中允许 FastVibe；拒绝权限时动作会返回可读错误。" }
                    } else if cfg!(target_os = "windows") {
                        if english { "Windows requires PowerShell and desktop automation access; missing system components return a readable error." } else { "Windows 需要允许 PowerShell 与桌面自动化访问；缺少系统组件时动作会返回可读错误。" }
                    } else if supported {
                        if english { "The Linux desktop must allow xdotool to access the current display session; missing dependencies return a readable error." } else { "Linux 桌面需要允许 xdotool 访问当前显示会话；缺少依赖时动作会返回可读错误。" }
                    } else {
                        if english { "This platform has no computer-control dependencies." } else { "当前平台没有电脑操控依赖。" }
                    }),
            )
            .into_any_element()
    }

    fn save_proxy(&mut self, cx: &mut Context<Self>) {
        let Some(settings) = self.settings.as_ref() else {
            return;
        };
        self.patch_settings(
            AppSettingsPatch {
                proxy_url: Some(value(&settings.proxy.url, cx)),
                ..Default::default()
            },
            cx,
        );
    }

    fn proxy_pane(&self, s: &SettingsState, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        card(p)
            .p(px(16.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_size(px(TEXT_SM)).child(if english {
                        "Network proxy"
                    } else {
                        "网络代理"
                    }))
                    .child(
                        outline_button("save-proxy", p)
                            .child(if english { "Save" } else { "保存" })
                            .on_click(cx.listener(|this, _, _, cx| this.save_proxy(cx))),
                    ),
            )
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(if english {
                        "Used for model requests, catalog refreshes, and model lists. Supports HTTP(S) and SOCKS proxies; leave empty for the system default."
                    } else {
                        "用于模型请求、模型目录刷新和模型列表读取。支持 HTTP(S) 与 SOCKS 代理；留空使用系统默认。"
                    }),
            )
            .child(Input::new(&s.proxy.url).small())
            .into_any_element()
    }

    fn providers_pane(
        &self,
        s: &SettingsState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let providers = s.providers.as_deref();
        let query = s.search.read(cx).value().trim().to_lowercase();

        // 会话模型: the model and thinking a new conversation starts with.
        let current = match &self.defaults.model {
            Some(label) => self
                .models
                .iter()
                .find(|m| &m.label == label)
                .map(|m| format!("{}/{}", m.provider_name, m.model.id))
                .unwrap_or_else(|| label.clone()),
            None => if english { "Not set" } else { "未设置" }.to_string(),
        };
        let effective_thinking = self
            .defaults
            .model
            .as_ref()
            .and_then(|l| self.models.iter().find(|m| &m.label == l))
            .map_or(self.defaults.thinking, |m| {
                m.model.effective_thinking(self.defaults.thinking)
            });
        let thinking = effective_thinking
            .map(|level| {
                if english {
                    match level {
                        ThinkingLevel::Minimal => "Minimal",
                        ThinkingLevel::Low => "Low",
                        ThinkingLevel::Medium => "Medium",
                        ThinkingLevel::High => "High",
                        ThinkingLevel::Xhigh => "Very high",
                        ThinkingLevel::Max => "Maximum",
                    }
                } else {
                    thinking_label(level)
                }
            })
            .unwrap_or(if english { "Default" } else { "默认" });
        let default_row = div()
            .relative()
            .px(px(16.0))
            .py(px(12.0))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(24.0))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .font_weight(FontWeight::MEDIUM)
                            .child(if english { "Conversation model" } else { "会话模型" }),
                    )
                    .child(
                        div()
                            .mt(px(2.0))
                            .text_size(px(TEXT_XS))
                            .line_height(px(16.0))
                            .muted(p)
                            .child(if english { "New chats use this model and thinking level; individual chats can still switch temporarily." } else { "新建对话使用这个模型和推理强度，单个对话仍可临时切换。" }),
                    ),
            )
            .child(
                outline_button("default-model", p)
                    .h(px(36.0))
                    .rounded(px(10.0))
                    .child(SharedString::from(format!("{current} · {thinking}")))
                    .child(icon("arrow-down01", 12.0, p.c(Token::MutedForeground)))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(s) = &mut this.settings {
                            s.default_menu = !s.default_menu;
                        }
                        cx.notify();
                    })),
            )
            .when(s.default_menu, |d| {
                d.child(ui::float(self.default_menu(cx)))
            });

        let count = providers.map(|l| l.len()).unwrap_or(0);
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .child(
                div()
                    .pl(px(4.0))
                    .flex()
                    .gap(px(6.0))
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(if english { "Providers" } else { "供应商" })
                    .child(div().muted(p).child(SharedString::from(count.to_string()))),
            )
            .child(
                outline_button("add-provider", p)
                    .child(icon("add01", 14.0, p.c(Token::Foreground)))
                    .child(if english {
                        "Add provider"
                    } else {
                        "添加供应商"
                    })
                    .on_click(
                        cx.listener(|this, _, window, cx| this.open_add_provider(window, cx)),
                    ),
            );

        let mut list = card(p);
        match providers {
            None => {
                list = list.child(
                    div()
                        .px(px(16.0))
                        .py(px(20.0))
                        .text_size(px(TEXT_SM))
                        .muted(p)
                        .child(if english {
                            "Loading providers…"
                        } else {
                            "正在加载供应商…"
                        }),
                )
            }
            Some([]) => {
                list = list.child(
                    div()
                        .px(px(16.0))
                        .py(px(28.0))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            div()
                                .text_size(px(TEXT_SM))
                                .font_weight(FontWeight::MEDIUM)
                                .child(if english {
                                    "Add your first provider"
                                } else {
                                    "添加第一个供应商"
                                }),
                        )
                        .child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                            "Connect an API key and choose the models to use."
                        } else {
                            "连接 API 密钥，选择要使用的模型。"
                        })),
                )
            }
            Some(all) => {
                for (i, provider) in all.iter().enumerate() {
                    let matches = query.is_empty()
                        || provider.name.to_lowercase().contains(&query)
                        || provider
                            .models
                            .iter()
                            .any(|m| m.id.to_lowercase().contains(&query));
                    if matches {
                        list = list.child(self.provider_row(provider, i > 0, s, window, cx));
                    }
                }
            }
        }

        let mut col = div().flex().flex_col().gap(px(20.0));
        if let Some(n) = &s.notice {
            col = col.child(
                div()
                    .text_size(px(TEXT_SM))
                    .text_color(p.c(Token::Destructive))
                    .child(SharedString::from(n.clone())),
            );
        }
        col.child(card(p).child(default_row)).child(
            div()
                .flex()
                .flex_col()
                .gap(px(12.0))
                .child(header)
                .child(Input::new(&s.search).prefix(icon(
                    "search01",
                    14.0,
                    p.c(Token::MutedForeground),
                )))
                .child(list),
        )
    }

    /// 偏好设置 → 外观: mode, the two themes, and the translucent window.
    /// 偏好设置: how the app looks, then what commands may do.
    fn general_pane(&self, s: &SettingsState, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap(px(24.0))
            .child(self.appearance_section(s, cx))
            .child(self.sandbox_section(s, cx))
    }

    /// 沙箱与审批: codex's sandbox modes and approval policies, and whether the network is open.
    fn sandbox_section(&self, s: &SettingsState, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let a = &self.app_settings;
        let english = a.language == UiLanguage::English;
        let hover = p.c(Token::Accent);
        let modes: [(SandboxMode, &str); 3] = [
            (
                SandboxMode::ReadOnly,
                if english { "Read only" } else { "只读" },
            ),
            (
                SandboxMode::WorkspaceWrite,
                if english {
                    "Workspace write"
                } else {
                    "工作区可写"
                },
            ),
            (
                SandboxMode::DangerFullAccess,
                if english {
                    "Full access"
                } else {
                    "完全访问"
                },
            ),
        ];
        let policies: [(ApprovalPolicy, &str); 4] = [
            (
                ApprovalPolicy::OnRequest,
                if english {
                    "Ask when needed"
                } else {
                    "按需询问"
                },
            ),
            (
                ApprovalPolicy::OnFailure,
                if english {
                    "Ask after failure"
                } else {
                    "失败后询问"
                },
            ),
            (
                ApprovalPolicy::Untrusted,
                if english {
                    "Ask for untrusted"
                } else {
                    "不受信任时询问"
                },
            ),
            (
                ApprovalPolicy::Never,
                if english { "Never ask" } else { "从不询问" },
            ),
        ];
        let label_of = |m: SandboxMode| {
            modes
                .iter()
                .find(|(x, _)| *x == m)
                .map(|(_, l)| *l)
                .unwrap_or("")
        };
        let policy_label = |m: ApprovalPolicy| {
            policies
                .iter()
                .find(|(x, _)| *x == m)
                .map(|(_, l)| *l)
                .unwrap_or("")
        };
        let button = |id: &'static str, which: ThemeMenu, text: &str, cx: &mut Context<Self>| {
            outline_button(id, p)
                .w(px(172.0))
                .h(px(36.0))
                .justify_between()
                .rounded(px(10.0))
                .font_weight(FontWeight::NORMAL)
                .text_size(px(TEXT_SM))
                .child(SharedString::from(text.to_string()))
                .child(icon("unfold-more", 14.0, p.c(Token::MutedForeground)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        s.theme_menu = if s.theme_menu == Some(which) {
                            None
                        } else {
                            Some(which)
                        };
                    }
                    cx.notify();
                }))
        };
        let mut mode_menu = popover(p)
            .absolute()
            .top(px(40.0))
            .right(px(0.0))
            .w(px(172.0));
        for (m, label) in modes {
            mode_menu = mode_menu.child(
                menu_item(
                    SharedString::from(format!("sandbox-{m:?}")),
                    a.sandbox_mode == m,
                    hover,
                )
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        s.theme_menu = None;
                    }
                    this.patch_settings(
                        AppSettingsPatch {
                            sandbox_mode: Some(m),
                            ..Default::default()
                        },
                        cx,
                    )
                })),
            );
        }

        let mut policy_menu = popover(p)
            .absolute()
            .top(px(40.0))
            .right(px(0.0))
            .w(px(172.0));
        for (m, label) in policies {
            policy_menu = policy_menu.child(
                menu_item(
                    SharedString::from(format!("approval-{m:?}")),
                    a.approval_policy == m,
                    hover,
                )
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        s.theme_menu = None;
                    }
                    this.patch_settings(
                        AppSettingsPatch {
                            approval_policy: Some(m),
                            ..Default::default()
                        },
                        cx,
                    )
                })),
            );
        }
        let mode_btn = button(
            "sandbox-mode",
            ThemeMenu::Sandbox,
            label_of(a.sandbox_mode),
            cx,
        );
        let policy_btn = button(
            "approval-policy",
            ThemeMenu::Approval,
            policy_label(a.approval_policy),
            cx,
        );
        let network = a.sandbox_network;
        let network_usable = a.sandbox_mode == SandboxMode::WorkspaceWrite;
        let mode_note = match a.sandbox_mode {
            SandboxMode::ReadOnly => {
                if english {
                    "Commands can read but cannot write files"
                } else {
                    "命令只能读，不能写任何文件"
                }
            }
            SandboxMode::WorkspaceWrite => {
                if english {
                    "Commands can read anywhere but can write only project folders and temporary directories"
                } else {
                    "命令可读任何位置，只能写项目文件夹和临时目录"
                }
            }
            SandboxMode::DangerFullAccess => {
                if english {
                    "Commands have no restrictions; use only in a trusted environment"
                } else {
                    "命令不受任何限制，请只在信任的环境里使用"
                }
            }
        };
        let policy_note = match a.approval_policy {
            ApprovalPolicy::OnRequest => {
                if english {
                    "Commands run in the sandbox; the model asks before leaving it"
                } else {
                    "命令在沙箱里直接运行；需要离开沙箱时由模型来问你"
                }
            }
            ApprovalPolicy::OnFailure => {
                if english {
                    "Commands run in the sandbox; after a block, ask whether to retry without it"
                } else {
                    "命令在沙箱里直接运行；被沙箱挡住后问你是否不用沙箱重试"
                }
            }
            ApprovalPolicy::Untrusted => {
                if english {
                    "Ask first except for known read-only commands"
                } else {
                    "除了已知只读的命令，其余都先问你"
                }
            }
            ApprovalPolicy::Never => {
                if english {
                    "Never ask: a sandbox block remains a block"
                } else {
                    "从不询问：沙箱挡住的就是挡住了"
                }
            }
        };
        div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .pl(px(4.0))
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(if english { "Sandbox & approvals" } else { "沙箱与审批" }),
            )
            .child(
                card(p)
                    .child(setting_row(
                        if english { "Sandbox mode" } else { "沙箱模式" },
                        mode_note,
                        false,
                        p,
                        div()
                            .relative()
                            .child(mode_btn)
                            .when(s.theme_menu == Some(ThemeMenu::Sandbox), |d| {
                                d.child(ui::float(mode_menu))
                            }),
                    ))
                    .child(setting_row(
                        if english { "Approval policy" } else { "审批策略" },
                        policy_note,
                        true,
                        p,
                        div()
                            .relative()
                            .child(policy_btn)
                            .when(s.theme_menu == Some(ThemeMenu::Approval), |d| {
                                d.child(ui::float(policy_menu))
                            }),
                    ))
                    .child(setting_row(
                        if english { "Allow network access" } else { "允许联网" },
                        if network_usable {
                            if english { "Sandboxed commands can access the network" } else { "沙箱里的命令可以访问网络" }
                        } else {
                            if english { "Only applies to Workspace write; Full access is already unrestricted and Read only has no network" } else { "只在「工作区可写」下有效；完全访问本来就不限网络，只读不开放" }
                        },
                        true,
                        p,
                        switch(SharedString::from("sandbox-network"), network, p)
                            .opacity(if network_usable { 1.0 } else { 0.5 })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.patch_settings(
                                    AppSettingsPatch {
                                        sandbox_network: Some(!network),
                                        ..Default::default()
                                    },
                                    cx,
                                )
                            })),
                    )),
            )
    }

    /// 外观: mode, the two themes, and the translucent window.
    fn appearance_section(&self, s: &SettingsState, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let a = &self.app_settings;
        let reply_suggestions = a.reply_suggestions;
        let auto_compaction_enabled = a.auto_compaction_enabled;
        let code_mode_enabled = a.code_mode_enabled;
        let auto_archive = a.auto_archive_after_days.is_some();
        let keep_awake = a.keep_awake;
        let english = a.language == UiLanguage::English;
        let hover = p.c(Token::Accent);
        let language_label = |language: UiLanguage| match language {
            UiLanguage::Chinese => "中文",
            UiLanguage::English => "English",
        };
        let mode_label = |m: ThemeMode| match m {
            ThemeMode::System => {
                if english {
                    "System"
                } else {
                    "跟随系统"
                }
            }
            ThemeMode::Light => {
                if english {
                    "Light"
                } else {
                    "亮色"
                }
            }
            ThemeMode::Dark => {
                if english {
                    "Dark"
                } else {
                    "暗色"
                }
            }
        };
        let select =
            |id: &'static str, which: ThemeMenu, content: AnyElement, cx: &mut Context<Self>| {
                outline_button(id, p)
                    .w(px(172.0))
                    .h(px(36.0))
                    .justify_between()
                    .rounded(px(10.0))
                    .font_weight(FontWeight::NORMAL)
                    .text_size(px(TEXT_SM))
                    .child(content)
                    .child(icon("unfold-more", 14.0, p.c(Token::MutedForeground)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(s) = &mut this.settings {
                            s.theme_menu = if s.theme_menu == Some(which) {
                                None
                            } else {
                                Some(which)
                            };
                        }
                        cx.notify();
                    }))
            };

        let mut mode_menu = popover(p)
            .absolute()
            .top(px(40.0))
            .right(px(0.0))
            .w(px(172.0));
        for m in [ThemeMode::System, ThemeMode::Light, ThemeMode::Dark] {
            mode_menu = mode_menu.child(
                menu_item(
                    SharedString::from(format!("mode-{m:?}")),
                    a.theme_mode == m,
                    hover,
                )
                .child(mode_label(m))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        s.theme_menu = None;
                    }
                    this.patch_settings(
                        AppSettingsPatch {
                            theme_mode: Some(m),
                            ..Default::default()
                        },
                        cx,
                    )
                })),
            );
        }

        let mut language_menu = popover(p)
            .absolute()
            .top(px(40.0))
            .right(px(0.0))
            .w(px(172.0));
        for language in [UiLanguage::Chinese, UiLanguage::English] {
            language_menu = language_menu.child(
                menu_item(
                    SharedString::from(format!("language-{language:?}")),
                    a.language == language,
                    hover,
                )
                .child(language_label(language))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        s.theme_menu = None;
                    }
                    this.patch_settings(
                        AppSettingsPatch {
                            language: Some(language),
                            ..Default::default()
                        },
                        cx,
                    )
                })),
            );
        }

        let theme_list = |kind: fv_theme::ThemeKind, current: &str, cx: &mut Context<Self>| {
            let menu = popover(p)
                .absolute()
                .top(px(40.0))
                .right(px(0.0))
                .w(px(220.0))
                .max_h(px(320.0));
            let mut rows = div().id("theme-list").overflow_y_scroll().flex().flex_col();
            for id in fv_theme::ids_for(kind) {
                let theme_id = id.clone();
                let Some(seed) = fv_theme::seed(id) else {
                    continue;
                };
                rows = rows.child(
                    menu_item(
                        SharedString::from(format!("theme-{id}")),
                        current == id,
                        hover,
                    )
                    .child(swatch(seed))
                    .child(ui::truncate(seed.label.clone()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(s) = &mut this.settings {
                            s.theme_menu = None;
                        }
                        let id = theme_id.clone();
                        this.patch_settings(
                            match kind {
                                fv_theme::ThemeKind::Light => AppSettingsPatch {
                                    light_theme: Some(id),
                                    ..Default::default()
                                },
                                fv_theme::ThemeKind::Dark => AppSettingsPatch {
                                    dark_theme: Some(id),
                                    ..Default::default()
                                },
                            },
                            cx,
                        )
                    })),
                );
            }
            menu.child(rows)
        };
        let theme_button =
            |id: &'static str, which: ThemeMenu, theme: &str, cx: &mut Context<Self>| {
                let content = match fv_theme::seed(theme) {
                    Some(seed) => div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(swatch(seed))
                        .child(ui::truncate(seed.label.clone()))
                        .into_any_element(),
                    None => div()
                        .child(SharedString::from(theme.to_string()))
                        .into_any_element(),
                };
                select(id, which, content, cx)
            };

        let light_btn = theme_button("light-theme", ThemeMenu::Light, &a.light_theme, cx);
        let dark_btn = theme_button("dark-theme", ThemeMenu::Dark, &a.dark_theme, cx);
        let mode_btn = select(
            "theme-mode",
            ThemeMenu::Mode,
            div().child(mode_label(a.theme_mode)).into_any_element(),
            cx,
        );
        let light_menu = theme_list(fv_theme::ThemeKind::Light, &a.light_theme, cx);
        let dark_menu = theme_list(fv_theme::ThemeKind::Dark, &a.dark_theme, cx);
        let language_btn = select(
            "ui-language",
            ThemeMenu::Language,
            div().child(language_label(a.language)).into_any_element(),
            cx,
        );
        let glass = a.glass;

        div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .pl(px(4.0))
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(if english { "Appearance" } else { "外观" }),
            )
            .child(
                card(p)
                    .child(setting_row(
                        if english { "Interface language" } else { "界面语言" },
                        if english {
                            "Switch the native interface language; untranslated copy falls back to Chinese"
                        } else {
                            "切换原生界面语言；未迁移的文案保留中文回退"
                        },
                        false,
                        p,
                        div()
                            .relative()
                            .child(language_btn)
                            .when(s.theme_menu == Some(ThemeMenu::Language), |d| {
                                d.child(ui::float(language_menu))
                            }),
                    ))
                    .child(setting_row(
                        if english { "Theme mode" } else { "主题模式" },
                        if english {
                            "Follow the macOS appearance when using System"
                        } else {
                            "跟随系统时随 macOS 外观自动切换"
                        },
                        false,
                        p,
                        div()
                            .relative()
                            .child(mode_btn)
                            .when(s.theme_menu == Some(ThemeMenu::Mode), |d| {
                                d.child(ui::float(mode_menu))
                            }),
                    ))
                    .child(setting_row(
                        if english { "Light theme" } else { "亮色主题" },
                        if english { "Theme used in Light mode" } else { "亮色模式下使用的主题" },
                        true,
                        p,
                        div()
                            .relative()
                            .child(light_btn)
                            .when(s.theme_menu == Some(ThemeMenu::Light), |d| {
                                d.child(ui::float(light_menu))
                            }),
                    ))
                    .child(setting_row(
                        if english { "Dark theme" } else { "暗色主题" },
                        if english { "Theme used in Dark mode" } else { "暗色模式下使用的主题" },
                        true,
                        p,
                        div()
                            .relative()
                            .child(dark_btn)
                            .when(s.theme_menu == Some(ThemeMenu::Dark), |d| {
                                d.child(ui::float(dark_menu))
                            }),
                    ))
                    .child(setting_row(
                        if english { "Glass effect" } else { "玻璃效果" },
                        if english {
                            "Make the window background translucent"
                        } else {
                            "窗口背景半透明，透出桌面"
                        },
                        true,
                        p,
                        switch(SharedString::from("glass"), glass, p).on_click(cx.listener(
                            move |this, _, _, cx| {
                                this.patch_settings(
                                    AppSettingsPatch {
                                        glass: Some(!glass),
                                        ..Default::default()
                                    },
                                    cx,
                                )
                            },
                        )),
                    ))
                    .child(setting_row(
                        if english { "Reply suggestions" } else { "回复推荐" },
                        if english {
                            "Suggest what you may say next after a reply; press Tab to insert it"
                        } else {
                            "回复结束后猜测你下一句，显示在输入框里，按 Tab 填入"
                        },
                        true,
                        p,
                        switch(
                            SharedString::from("reply-suggestions"),
                            reply_suggestions,
                            p,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.patch_settings(
                                AppSettingsPatch {
                                    reply_suggestions: Some(!reply_suggestions),
                                    ..Default::default()
                                },
                                cx,
                            )
                        })),
                    ))
                    .child(setting_row(
                        if english { "Code mode" } else { "代码模式" },
                        if english {
                            "Let the model orchestrate existing tools through isolated JavaScript; applies next turn"
                        } else {
                            "允许模型通过隔离 JavaScript 编排已有工具；使用现有权限，下个回合生效"
                        },
                        true,
                        p,
                        switch(SharedString::from("code-mode"), code_mode_enabled, p).on_click(
                            cx.listener(move |this, _, _, cx| {
                                this.patch_settings(
                                    AppSettingsPatch {
                                        code_mode_enabled: Some(!code_mode_enabled),
                                        ..Default::default()
                                    },
                                    cx,
                                )
                            }),
                        ),
                    ))
                    .child(setting_row(
                        if english { "Auto-compact context" } else { "自动压缩上下文" },
                        if english {
                            "Organize context near its limit while keeping the original messages"
                        } else {
                            "接近上下文上限时自动整理，保留原始消息；关闭后仍可手动整理"
                        },
                        true,
                        p,
                        switch(
                            SharedString::from("auto-compaction"),
                            auto_compaction_enabled,
                            p,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.patch_settings(
                                AppSettingsPatch {
                                    auto_compaction_enabled: Some(!auto_compaction_enabled),
                                    ..Default::default()
                                },
                                cx,
                            )
                        })),
                    ))
                    .child(setting_row(
                        if english { "Auto-archive old chats" } else { "自动归档旧对话" },
                        if english { "Every hour, archive chats inactive for 30 days that are not pinned and have no running task" } else { "每小时检查一次，将 30 天未活动、未置顶且没有运行任务的对话移入归档" },
                        true,
                        p,
                        switch(SharedString::from("auto-archive"), auto_archive, p).on_click(
                            cx.listener(move |this, _, _, cx| {
                                this.patch_settings(
                                    AppSettingsPatch {
                                        auto_archive_after_days: Some(if auto_archive {
                                            None
                                        } else {
                                            Some(30)
                                        }),
                                        ..Default::default()
                                    },
                                    cx,
                                )
                            }),
                        ),
                    ))
                    .child(setting_row(
                        if english { "Keep awake" } else { "保持唤醒" },
                        if english { "Prevent macOS from sleeping during replies or scheduled tasks; other platforms ignore this switch" } else { "生成回复或定时任务期间阻止 macOS 进入睡眠；其它平台会忽略此开关" },
                        true,
                        p,
                        switch(SharedString::from("keep-awake"), keep_awake, p).on_click(
                            cx.listener(move |this, _, _, cx| {
                                this.patch_settings(
                                    AppSettingsPatch {
                                        keep_awake: Some(!keep_awake),
                                        ..Default::default()
                                    },
                                    cx,
                                )
                            }),
                        ),
                    )),
            )
    }

    /// 归档对话: restore one to the sidebar, or delete it for good (after asking).
    fn archived_pane(&self, s: &SettingsState, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let mut col = div().flex().flex_col().gap(px(16.0)).child(
            div()
                .pl(px(4.0))
                .text_size(px(TEXT_XS))
                .muted(p)
                .child(if english { "Archiving hides a chat from the sidebar; its contents remain. Deleting removes the transcript and cannot be undone." } else { "归档只是从侧边栏收起，内容仍在；删除会一并移除会话记录，无法恢复。" }),
        );
        let list = match &s.archived {
            None => card(p).child(
                div()
                    .px(px(16.0))
                    .py(px(20.0))
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(if english { "Loading…" } else { "正在加载…" }),
            ),
            Some(items) if items.is_empty() => card(p).child(
                div()
                    .px(px(16.0))
                    .py(px(32.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .font_weight(FontWeight::MEDIUM)
                            .child(if english { "No archived chats" } else { "没有已归档的对话" }),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(if english { "Hover a chat in the sidebar and click the archive icon, or right-click and choose Archive." } else { "在侧边栏悬停对话点归档图标，或右键选择「归档」。" }),
                    ),
            ),
            Some(items) => {
                let mut card = card(p);
                for (i, t) in items.iter().enumerate() {
                    let (restore_id, delete_id) = (t.id.clone(), t.id.clone());
                    let project = t
                        .project
                        .as_deref()
                        .map(|path| self.project_label(path))
                        .unwrap_or_else(|| if english { "No project".to_string() } else { "无项目".to_string() });
                    card = card.child(
                        div()
                            .px(px(16.0))
                            .py(px(10.0))
                            .flex()
                            .items_center()
                            .gap(px(12.0))
                            .when(i > 0, |d| d.border_t_1().border_color(p.c(Token::Border)))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        ui::truncate(if t.title.is_empty() {
                                            text::UNTITLED.to_string()
                                        } else {
                                            t.title.clone()
                                        })
                                        .text_size(px(TEXT_SM))
                                        .font_weight(FontWeight::MEDIUM),
                                    )
                                    .child(ui::truncate(project).text_size(px(TEXT_XS)).muted(p)),
                            )
                            .child(
                                outline_button(SharedString::from(format!("restore-{}", t.id)), p)
                                    .child(if english { "Restore" } else { "恢复" })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.update_thread(
                                            ThreadUpdateParams {
                                                thread_id: restore_id.clone(),
                                                title: None,
                                                archived: Some(false),
                                                pinned: None,
                                            },
                                            cx,
                                        )
                                    })),
                            )
                            .child(
                                outline_button(SharedString::from(format!("delete-{}", t.id)), p)
                                    .text_color(p.c(Token::Destructive))
                                    .child(if english { "Delete" } else { "删除" })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if let Some(s) = &mut this.settings {
                                            s.confirm_delete = Some(delete_id.clone());
                                        }
                                        cx.notify();
                                    })),
                            ),
                    );
                }
                card
            }
        };
        col = col.child(list);
        col
    }

    fn default_menu(&self, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let mut menu = popover(p)
            .absolute()
            .top(px(52.0))
            .right(px(16.0))
            .w(px(300.0));
        menu = menu.child(menu_label("模型", p));
        if self.models.is_empty() {
            menu = menu.child(
                div()
                    .px(px(8.0))
                    .py(px(6.0))
                    .muted(p)
                    .child(text::NO_MODEL_HINT),
            );
        }
        for m in &self.models {
            let label = m.label.clone();
            let active = self.defaults.model.as_deref() == Some(m.label.as_str());
            menu = menu.child(
                menu_item(SharedString::from(format!("dm-{}", m.label)), active, hover)
                    .child(ui::truncate(format!("{}/{}", m.provider_name, m.model.id)).flex_1())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let thinking = this.defaults.thinking;
                        this.set_default(
                            ModelDefaults {
                                model: Some(label.clone()),
                                thinking,
                            },
                            cx,
                        )
                    })),
            );
        }
        menu = menu.child(div().my(px(4.0)).h(px(1.0)).bg(p.c(Token::Border)));
        menu = menu.child(menu_label("推理强度", p));
        menu = menu.child(
            menu_item(
                "default-thinking-inherit".into(),
                self.defaults.thinking.is_none(),
                hover,
            )
            .child("跟随模型默认")
            .on_click(cx.listener(|this, _, _, cx| {
                let model = this.defaults.model.clone();
                this.set_default(
                    ModelDefaults {
                        model,
                        thinking: None,
                    },
                    cx,
                );
            })),
        );
        let allowed = self
            .defaults
            .model
            .as_ref()
            .and_then(|l| self.models.iter().find(|m| &m.label == l))
            .map(|m| m.model.allowed_thinking());
        let effective = self
            .defaults
            .model
            .as_ref()
            .and_then(|l| self.models.iter().find(|m| &m.label == l))
            .map_or(self.defaults.thinking, |m| {
                m.model.effective_thinking(self.defaults.thinking)
            });
        for level in LEVELS {
            if allowed.as_ref().is_some_and(|v| !v.contains(&level)) {
                continue;
            }
            let active = effective == Some(level);
            menu = menu.child(
                menu_item(SharedString::from(format!("dl-{level:?}")), active, hover)
                    .child(thinking_label(level))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let model = this.defaults.model.clone();
                        this.set_default(
                            ModelDefaults {
                                model,
                                thinking: Some(level),
                            },
                            cx,
                        )
                    })),
            );
        }
        menu
    }

    fn provider_row(
        &self,
        provider: &ProviderInfo,
        divider: bool,
        s: &SettingsState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let id = provider.id.clone();
        let open = s.edit.as_ref().filter(|e| e.id == provider.id);
        let (toggle_id, delete_id, enable_id) = (id.clone(), id.clone(), id.clone());
        let enabled = provider.enabled;
        let head = div()
            .id(SharedString::from(format!("provider-{id}")))
            .h(px(48.0))
            .px(px(16.0))
            .flex()
            .items_center()
            .gap(px(10.0))
            .cursor_pointer()
            .child(icon("boxes", 16.0, p.c(Token::MutedForeground)))
            .child(
                ui::truncate(provider.name.clone())
                    .flex_1()
                    .text_size(px(15.0))
                    .font_weight(FontWeight::MEDIUM),
            )
            .when(!provider.has_key, |d| {
                d.child(
                    div()
                        .px(px(6.0))
                        .rounded_full()
                        .bg(p.c(Token::Warning).opacity(0.12))
                        .text_size(px(TEXT_XS))
                        .text_color(p.c(Token::Warning))
                        .child(if english {
                            "Not connected"
                        } else {
                            "未连接"
                        }),
                )
            })
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(SharedString::from(format!(
                        "{} {}",
                        provider.models.len(),
                        if english { "models" } else { "个模型" }
                    ))),
            )
            .child(
                icon_button_xs(SharedString::from(format!("delete-{id}")), "delete02", p).on_click(
                    cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.delete_provider(delete_id.clone(), cx)
                    }),
                ),
            )
            .child(
                switch(SharedString::from(format!("enable-{id}")), enabled, p).on_click(
                    cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.save_provider(&enable_id, None, |u| u.enabled = !enabled, cx)
                    }),
                ),
            )
            .child(icon(
                if open.is_some() {
                    "arrow-up01"
                } else {
                    "arrow-down01"
                },
                14.0,
                p.c(Token::MutedForeground),
            ))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.toggle_provider(toggle_id.clone(), window, cx)
            }));

        let mut row = div()
            .flex()
            .flex_col()
            .when(divider, |d| d.border_t_1().border_color(p.c(Token::Border)))
            .child(head);
        if let Some(edit) = open {
            row = row.child(self.provider_detail(provider, edit, window, cx));
        }
        row
    }

    fn provider_detail(
        &self,
        provider: &ProviderInfo,
        edit: &ProviderEdit,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let id = provider.id.clone();
        let hover = p.c(Token::Accent);
        let field = |zh: &'static str, en: &'static str| {
            div()
                .text_size(px(TEXT_XS))
                .muted(p)
                .mb(px(6.0))
                .child(if english { en } else { zh })
        };
        let (save_url_id, save_key_id, add_id, sync_id) =
            (id.clone(), id.clone(), id.clone(), id.clone());
        let base_state = edit.base_url.clone();
        let key_state = edit.key.clone();

        let mut protocol_menu = popover(p).absolute().top(px(36.0)).left(px(0.0)).w_full();
        for proto in PROTOCOLS {
            let pid = id.clone();
            protocol_menu = protocol_menu.child(
                menu_item(
                    SharedString::from(format!("proto-{id}-{proto:?}")),
                    proto == provider.protocol,
                    hover,
                )
                .child(protocol_label(proto))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(e) = this.settings.as_mut().and_then(|s| s.edit.as_mut()) {
                        e.protocol_menu = false;
                    }
                    this.save_provider(&pid, None, |u| u.protocol = proto, cx)
                })),
            );
        }

        let mut models = div().flex().flex_col();
        for m in &provider.models {
            let (pid, mid) = (id.clone(), m.id.clone());
            let (detail_pid, detail_mid) = (pid.clone(), mid.clone());
            let window_size = m.context_window.map(compact_tokens).unwrap_or_default();
            models = models.child(
                div()
                    .id(SharedString::from(format!("model-detail-{id}-{}", m.id)))
                    .h(px(32.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(TEXT_SM))
                    .cursor_pointer()
                    .hover(move |d| d.bg(hover))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_model_detail(detail_pid.clone(), detail_mid.clone(), window, cx)
                    }))
                    .child(ui::truncate(m.name.clone().unwrap_or_else(|| m.id.clone())).flex_1())
                    .when_some(m.protocol, |d, protocol| {
                        d.child(
                            div()
                                .px(px(5.0))
                                .rounded(px(5.0))
                                .border_1()
                                .border_color(p.c(Token::Border))
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(match protocol {
                                    ApiProtocol::Chat => "Chat",
                                    ApiProtocol::Responses => "Responses",
                                    ApiProtocol::Anthropic => "Anthropic",
                                    ApiProtocol::Google => "Google",
                                }),
                        )
                    })
                    .when(m.edited, |d| {
                        d.child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                            "Edited"
                        } else {
                            "已编辑"
                        }))
                    })
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(SharedString::from(window_size)),
                    )
                    .child(self.provider_check_button(
                        &id,
                        &m.id,
                        !provider.enabled || !provider.has_key,
                        cx,
                    ))
                    .child(
                        icon_button_xs(
                            SharedString::from(format!("rm-{id}-{}", m.id)),
                            "delete02",
                            p,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            let mid = mid.clone();
                            this.save_provider(
                                &pid,
                                None,
                                move |u| u.models.retain(|x| x.id != mid),
                                cx,
                            )
                        })),
                    ),
            );
        }
        if provider.models.is_empty() {
            models = models.child(div().py(px(8.0)).text_size(px(TEXT_XS)).muted(p).child(
                if provider.has_key {
                    if english {
                        "No models yet; click + to add"
                    } else {
                        "还没有模型，点击右上角添加"
                    }
                } else {
                    if english {
                        "Connect to choose models"
                    } else {
                        "连接后即可选择模型"
                    }
                },
            ));
        }

        div()
            .px(px(16.0))
            .pb(px(16.0))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(
                div().child(field("Base URL", "Base URL")).child(
                    div()
                        .flex()
                        .gap(px(6.0))
                        .child(div().flex_1().child(Input::new(&edit.base_url)))
                        .child(
                            outline_button(SharedString::from(format!("save-url-{id}")), p)
                                .child(if english { "Save" } else { "保存" })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    let url = value(&base_state, cx);
                                    this.save_provider(
                                        &save_url_id,
                                        None,
                                        move |u| u.base_url = url,
                                        cx,
                                    )
                                })),
                        ),
                ),
            )
            .child(
                div().child(field("API 格式", "API format")).child(
                    div()
                        .relative()
                        .child(
                            outline_button(SharedString::from(format!("proto-{id}")), p)
                                .font_weight(FontWeight::NORMAL)
                                .text_size(px(TEXT_SM))
                                .w_full()
                                .justify_between()
                                .child(protocol_label(provider.protocol))
                                .child(icon("unfold-more", 14.0, p.c(Token::MutedForeground)))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if let Some(e) =
                                        this.settings.as_mut().and_then(|s| s.edit.as_mut())
                                    {
                                        e.protocol_menu = !e.protocol_menu;
                                    }
                                    cx.notify();
                                })),
                        )
                        .when(edit.protocol_menu, |d| d.child(ui::float(protocol_menu))),
                ),
            )
            .child(
                div().child(field("API 密钥", "API key")).child(
                    div()
                        .flex()
                        .gap(px(6.0))
                        .child(div().flex_1().child(Input::new(&edit.key).mask_toggle()))
                        .child(
                            outline_button(SharedString::from(format!("save-key-{id}")), p)
                                .child(if english { "Save" } else { "保存" })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    let key = value(&key_state, cx);
                                    if key.is_empty() {
                                        return;
                                    }
                                    this.save_provider(&save_key_id, Some(key), |_| {}, cx)
                                })),
                        ),
                ),
            )
            .child(
                div()
                    .pt(px(12.0))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(28.0))
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .text_size(px(TEXT_SM))
                            .font_weight(FontWeight::MEDIUM)
                            .child(if english {
                                "Model list"
                            } else {
                                "模型列表"
                            })
                            .child(
                                div()
                                    .muted(p)
                                    .child(SharedString::from(provider.models.len().to_string())),
                            )
                            .child(div().flex_1())
                            .child(
                                icon_button_xs(
                                    SharedString::from(format!("add-models-{id}")),
                                    "add01",
                                    p,
                                )
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.open_add_models(add_id.clone(), window, cx)
                                    },
                                )),
                            )
                            .child(
                                icon_button_xs(
                                    SharedString::from(format!("sync-{id}")),
                                    "refresh",
                                    p,
                                )
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.open_add_models(sync_id.clone(), window, cx)
                                    },
                                )),
                            ),
                    )
                    .child(models),
            )
    }

    /// The dialogs Settings can raise, drawn over the whole window.
    pub(super) fn settings_dialogs(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let english = self.app_settings.language == UiLanguage::English;
        let s = self.settings.as_ref()?;
        if s.model_edit.is_some() {
            return self.model_detail_dialog(cx);
        }
        if let Some(a) = &s.add {
            return Some(modal(
                self.add_provider_dialog(a, cx),
                &self.palette,
                cx,
                |this| {
                    if let Some(s) = &mut this.settings {
                        s.add = None;
                    }
                },
            ));
        }
        if let Some(id) = &s.confirm_delete {
            let title = s
                .archived
                .as_ref()
                .and_then(|l| l.iter().find(|t| &t.id == id))
                .map(|t| t.title.clone())
                .unwrap_or_default();
            let target = id.clone();
            let body = dialog_card(&self.palette, 448.0)
                .child(dialog_head(
                    if english { "Delete this chat?" } else { "删除这个对话？" },
                    &if english { format!("{title} and all of its messages will be permanently deleted and cannot be recovered.") } else { format!("「{title}」及其全部消息会被删除，无法恢复。") },
                    &self.palette,
                ))
                .child(dialog_foot(
                    &self.palette,
                    cx,
                    |this, cx| {
                        if let Some(s) = &mut this.settings {
                            s.confirm_delete = None;
                        }
                        cx.notify();
                    },
                    if english { "Delete" } else { "删除" },
                    move |this, _, cx| {
                        if let Some(s) = &mut this.settings {
                            s.confirm_delete = None;
                        }
                        this.delete_thread(target.clone(), cx);
                    },
                    false,
                ));
            return Some(modal(body, &self.palette, cx, |this| {
                if let Some(s) = &mut this.settings {
                    s.confirm_delete = None;
                }
            }));
        }
        if let Some(am) = &s.add_models {
            let name = s
                .providers
                .as_ref()
                .and_then(|l| l.iter().find(|p| p.id == am.provider_id))
                .map(|p| p.name.clone())
                .unwrap_or_default();
            let body = dialog_card(&self.palette, 672.0)
                .child(dialog_head(
                    &if english {
                        format!("Manage models · {name}")
                    } else {
                        format!("管理模型 · {name}")
                    },
                    if english {
                        "Select the models to use."
                    } else {
                        "勾选要使用的模型。"
                    },
                    &self.palette,
                ))
                .child(div().px(px(20.0)).pb(px(16.0)).child(self.picker(
                    &am.picker,
                    |s| s.add_models.as_mut().map(|a| &mut a.picker),
                    cx,
                )))
                .child(dialog_foot(
                    &self.palette,
                    cx,
                    |this, cx| {
                        if let Some(s) = &mut this.settings {
                            s.add_models = None;
                        }
                        cx.notify();
                    },
                    if am.busy {
                        if english {
                            "Saving…"
                        } else {
                            "正在保存…"
                        }
                    } else {
                        if english { "Confirm" } else { "确认" }
                    },
                    |this, _, cx| this.finish_add_models(cx),
                    am.busy,
                ));
            return Some(modal(body, &self.palette, cx, |this| {
                if let Some(s) = &mut this.settings {
                    s.add_models = None;
                }
            }));
        }
        None
    }

    fn add_provider_dialog(&self, a: &AddProvider, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let hover = p.c(Token::Accent);
        if let Some(picker) = &a.picker {
            let n = picker.chosen.len();
            return dialog_card(p, 672.0)
                .child(dialog_head(
                    if english {
                        "Choose models"
                    } else {
                        "选择模型"
                    },
                    &match &picker.models {
                        Some(list) => {
                            if english {
                                format!("Fetched {} models; select the ones to add.", list.len())
                            } else {
                                format!("已获取 {} 个模型，勾选后加入。", list.len())
                            }
                        }
                        None => {
                            if english {
                                "Fetching model list…".to_string()
                            } else {
                                "正在拉取模型列表…".to_string()
                            }
                        }
                    },
                    p,
                ))
                .child(
                    div()
                        .px(px(20.0))
                        .pb(px(16.0))
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(self.picker(
                            picker,
                            |s| s.add.as_mut().and_then(|a| a.picker.as_mut()),
                            cx,
                        ))
                        .when_some(a.error.clone(), |d, e| {
                            d.child(
                                div()
                                    .text_size(px(TEXT_XS))
                                    .text_color(p.c(Token::Destructive))
                                    .child(SharedString::from(e)),
                            )
                        }),
                )
                .child(dialog_foot(
                    p,
                    cx,
                    |this, cx| {
                        if let Some(a) = this.settings.as_mut().and_then(|s| s.add.as_mut()) {
                            a.picker = None;
                            a.busy = false;
                        }
                        cx.notify();
                    },
                    &if english {
                        format!("Add {n} models")
                    } else {
                        format!("添加 {n} 个模型")
                    },
                    |this, _, cx| this.finish_add_provider(cx),
                    n == 0 || a.busy,
                ));
        }

        let label = |t: &'static str| {
            div()
                .text_size(px(12.8))
                .font_weight(FontWeight::MEDIUM)
                .mb(px(6.0))
                .child(t)
        };
        let mut form = div()
            .px(px(20.0))
            .pb(px(16.0))
            .flex()
            .flex_col()
            .gap(px(12.0));
        {
            let mut menu = popover(p).absolute().top(px(36.0)).left(px(0.0)).w_full();
            for proto in PROTOCOLS {
                menu = menu.child(
                    menu_item(
                        SharedString::from(format!("new-proto-{proto:?}")),
                        proto == a.protocol,
                        hover,
                    )
                    .child(protocol_label(proto))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(a) = this.settings.as_mut().and_then(|s| s.add.as_mut()) {
                            a.protocol = proto;
                            a.protocol_menu = false;
                        }
                        cx.notify();
                    })),
                );
            }
            form = form
                .child(
                    div()
                        .child(label(if english { "Name" } else { "名称" }))
                        .child(Input::new(&a.name)),
                )
                .child(
                    div()
                        .child(label("Base URL"))
                        .child(Input::new(&a.base_url)),
                )
                .child(
                    div()
                        .child(label(if english { "API format" } else { "API 格式" }))
                        .child(
                            div()
                                .relative()
                                .child(
                                    outline_button("new-proto", p)
                                        .font_weight(FontWeight::NORMAL)
                                        .text_size(px(TEXT_SM))
                                        .w_full()
                                        .justify_between()
                                        .child(protocol_label(a.protocol))
                                        .child(icon(
                                            "unfold-more",
                                            14.0,
                                            p.c(Token::MutedForeground),
                                        ))
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            if let Some(a) =
                                                this.settings.as_mut().and_then(|s| s.add.as_mut())
                                            {
                                                a.protocol_menu = !a.protocol_menu;
                                            }
                                            cx.notify();
                                        })),
                                )
                                .when(a.protocol_menu, |d| d.child(ui::float(menu))),
                        ),
                );
        }
        form = form
            .child(
                div()
                    .child(label(if english { "API key" } else { "API 密钥" }))
                    .child(Input::new(&a.key).mask_toggle()),
            )
            .when_some(a.error.clone(), |d, e| {
                d.child(
                    div()
                        .text_size(px(TEXT_XS))
                        .text_color(p.c(Token::Destructive))
                        .child(SharedString::from(e)),
                )
            });
        dialog_card(p, 448.0)
            .child(dialog_head(
                if english {
                    "Add provider"
                } else {
                    "添加供应商"
                },
                if english {
                    "Enter a name, URL, and API key."
                } else {
                    "填写名称、地址和密钥。"
                },
                p,
            ))
            .child(form)
            .child(dialog_foot(
                p,
                cx,
                |this, cx| {
                    if let Some(s) = &mut this.settings {
                        s.add = None;
                    }
                    cx.notify();
                },
                if a.busy {
                    if english {
                        "Fetching…"
                    } else {
                        "正在拉取…"
                    }
                } else {
                    if english { "Confirm" } else { "确认" }
                },
                |this, window, cx| this.confirm_add_provider(window, cx),
                a.busy,
            ))
    }

    /// `ModelPicker`: search, then one row per model with a check box.
    fn picker(
        &self,
        picker: &Picker,
        target: fn(&mut SettingsState) -> Option<&mut Picker>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let query = picker.search.read(cx).value().trim().to_lowercase();
        let hover = p.c(Token::Muted).opacity(0.5);
        let mut rows = div().flex().flex_col();
        match &picker.models {
            None => {
                rows = rows.child(
                    div()
                        .py(px(40.0))
                        .flex()
                        .justify_center()
                        .text_size(px(TEXT_XS))
                        .muted(p)
                        .child(if english {
                            "Fetching model list…"
                        } else {
                            "正在拉取模型列表…"
                        }),
                )
            }
            Some(list) if list.is_empty() => {
                rows = rows.child(
                    div()
                        .py(px(40.0))
                        .flex()
                        .justify_center()
                        .text_size(px(TEXT_XS))
                        .text_color(if picker.error.is_some() {
                            p.c(Token::Destructive)
                        } else {
                            p.c(Token::MutedForeground)
                        })
                        .child(SharedString::from(picker.error.clone().unwrap_or_else(
                            || {
                                if english {
                                    "No models".to_string()
                                } else {
                                    "没有模型".to_string()
                                }
                            },
                        ))),
                )
            }
            Some(list) => {
                for (i, m) in list.iter().enumerate() {
                    if !query.is_empty()
                        && !m.id.to_lowercase().contains(&query)
                        && !m
                            .name
                            .as_deref()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&query)
                    {
                        continue;
                    }
                    let checked = picker.chosen.contains(&m.id);
                    let mid = m.id.clone();
                    rows = rows.child(
                        div()
                            .id(SharedString::from(format!("pick-{}", m.id)))
                            .px(px(12.0))
                            .py(px(8.0))
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .cursor_pointer()
                            .when(i > 0, |d| d.border_t_1().border_color(p.c(Token::Border)))
                            .hover(move |d| d.bg(hover))
                            .child(checkbox(checked, p))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        ui::truncate(
                                            m.name.clone().unwrap_or_else(|| m.id.clone()),
                                        )
                                        .text_size(px(TEXT_XS))
                                        .font_weight(FontWeight::MEDIUM),
                                    )
                                    .child(
                                        ui::truncate(m.id.clone()).text_size(px(TEXT_XS)).muted(p),
                                    ),
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(pk) = this.settings.as_mut().and_then(target)
                                    && !pk.chosen.remove(&mid)
                                {
                                    pk.chosen.insert(mid.clone());
                                }
                                cx.notify();
                            })),
                    );
                }
            }
        }
        let total = picker.models.as_ref().map(|l| l.len()).unwrap_or(0);
        div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().flex_1().child(Input::new(&picker.search).prefix(icon(
                        "search01",
                        14.0,
                        p.c(Token::MutedForeground),
                    ))))
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(SharedString::from(format!(
                                "{} / {}",
                                picker.chosen.len(),
                                total
                            ))),
                    ),
            )
            .child(
                div()
                    .id("picker-rows")
                    .h(px(288.0))
                    .overflow_y_scroll()
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(p.c(Token::Border))
                    .child(rows),
            )
    }
}

/// Dev-only (capture builds): drive 添加供应商 → 选择模型 → 添加 the way a person would, so the
/// flow can be checked against a real server without clicking.
#[cfg(feature = "capture")]
impl Workspace {
    pub fn script_add_custom_provider(
        &mut self,
        name: &str,
        base_url: &str,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_settings(Section::Providers, window, cx);
        self.open_add_provider(window, cx);
        if let Some(a) = self.settings.as_mut().and_then(|s| s.add.as_mut()) {
            let (n, u, k) = (a.name.clone(), a.base_url.clone(), a.key.clone());
            n.update(cx, |st, cx| st.set_value(name.to_string(), window, cx));
            u.update(cx, |st, cx| st.set_value(base_url.to_string(), window, cx));
            k.update(cx, |st, cx| st.set_value(key.to_string(), window, cx));
        }
        self.confirm_add_provider(window, cx);
    }

    /// Tick every fetched model; true once there were some to tick.
    pub fn script_pick_all(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(pk) = self
            .settings
            .as_mut()
            .and_then(|s| s.add.as_mut())
            .and_then(|a| a.picker.as_mut())
        else {
            return false;
        };
        let Some(models) = &pk.models else {
            return false;
        };
        pk.chosen = models.iter().map(|m| m.id.clone()).collect();
        cx.notify();
        !pk.chosen.is_empty()
    }

    /// Type `text` into the composer and send it, as Enter would.
    pub fn script_send(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let input = self.input.clone();
        input.update(cx, |st, cx| st.set_value(text.to_string(), window, cx));
        self.skip_model_check = true;
        self.send(window, cx);
    }

    pub fn script_finish_add(&mut self, cx: &mut Context<Self>) {
        self.finish_add_provider(cx);
    }

    pub fn script_expand_first_provider(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let id = self
            .settings
            .as_ref()
            .and_then(|s| s.providers.as_ref())
            .and_then(|l| l.first())
            .map(|p| p.id.clone());
        if let Some(id) = id {
            self.toggle_provider(id, window, cx);
        }
    }
}

// ---- pieces shared by the panes

/// `SettingsRow`: a title, a one-line description, and the control on the right.
pub(super) fn setting_row(
    title: &str,
    description: &str,
    divider: bool,
    p: &crate::theme::Palette,
    control: impl IntoElement,
) -> Div {
    div()
        .px(px(16.0))
        .py(px(12.0))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(24.0))
        .when(divider, |d| d.border_t_1().border_color(p.c(Token::Border)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .text_size(px(TEXT_SM))
                        .font_weight(FontWeight::MEDIUM)
                        .child(SharedString::from(title.to_string())),
                )
                .child(
                    div()
                        .mt(px(2.0))
                        .text_size(px(TEXT_XS))
                        .line_height(px(16.0))
                        .muted(p)
                        .child(SharedString::from(description.to_string())),
                ),
        )
        .child(div().flex_none().child(control))
}

/// A theme's preview: its page colour with three bars in its accents.
fn swatch(seed: &fv_theme::Seed) -> Div {
    let bar = |c: fv_theme::Color| {
        div()
            .w(px(2.0))
            .h(px(10.0))
            .rounded_full()
            .bg(crate::theme::hsla(c))
    };
    div()
        .size(px(20.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(2.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(crate::theme::hsla(seed.border))
        .bg(crate::theme::hsla(seed.bg))
        .child(bar(seed.accent))
        .child(bar(seed.success))
        .child(bar(seed.warning))
}

/// `SettingsGroup`'s card: rounded, bordered, rows divided by hairlines.
pub(super) fn card(p: &crate::theme::Palette) -> Div {
    div()
        .rounded(px(14.0))
        .border_1()
        .border_color(p.c(Token::Border))
        .bg(p.c(Token::Card))
        .overflow_hidden()
        .flex()
        .flex_col()
}

/// `Button variant="outline" size="sm"`.
pub(super) fn outline_button(id: impl Into<ElementId>, p: &crate::theme::Palette) -> Stateful<Div> {
    let hover = p.c(Token::Muted);
    div()
        .id(id)
        .h(px(32.0))
        .px(px(10.0))
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(p.c(Token::Border))
        .bg(p.c(Token::Background))
        .cursor_pointer()
        .text_size(px(12.8))
        .font_weight(FontWeight::MEDIUM)
        .hover(move |d| d.bg(hover))
}

/// `.overlay-surface` under glass: rounder, no border, a hairline edge, the long soft shadow
/// and the specular rim. Solid themes keep the card.
fn overlay_surface(d: Div, radius: f32, p: &crate::theme::Palette) -> Div {
    match (p.get(Token::GlassEdge), p.get(Token::GlassShade)) {
        (Some(edge), Some(shade)) => {
            let shadow = |color: Hsla, y: f32, blur: f32, spread: f32| BoxShadow {
                color,
                offset: point(px(0.0), px(y)),
                blur_radius: px(blur),
                spread_radius: px(spread),
                inset: false,
            };
            d.rounded(px(14.0))
                .relative()
                .shadow(vec![
                    shadow(edge, 0.0, 0.0, 0.5),
                    shadow(shade, 18.0, 40.0, -14.0),
                    shadow(shade, 2.0, 8.0, -2.0),
                ])
                .child(crate::ui::glass_rim(14.0, p).unwrap_or_else(div))
        }
        _ => d
            .rounded(px(radius))
            .border_1()
            .border_color(p.c(Token::Border))
            .shadow_lg(),
    }
}

pub(super) fn popover(p: &crate::theme::Palette) -> Div {
    overlay_surface(div().p(px(4.0)), 10.0, p)
        .bg(p.overlay())
        .text_color(p.c(Token::PopoverForeground))
        .flex()
        .flex_col()
        .text_size(px(TEXT_SM))
}

pub(super) fn menu_label(t: &'static str, p: &crate::theme::Palette) -> Div {
    div()
        .px(px(8.0))
        .py(px(4.0))
        .text_size(px(TEXT_XS))
        .font_weight(FontWeight::MEDIUM)
        .muted(p)
        .child(t)
}

pub(super) fn menu_item(id: SharedString, active: bool, hover: Hsla) -> Stateful<Div> {
    div()
        .id(id)
        .min_h(px(32.0))
        .px(px(8.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .rounded(px(6.0))
        .cursor_pointer()
        .when(active, move |d| d.bg(hover))
        .hover(move |d| d.bg(hover))
}

/// `Switch size="sm"`: a 24×14 pill.
pub(super) fn switch(id: SharedString, on: bool, p: &crate::theme::Palette) -> Stateful<Div> {
    div()
        .id(id)
        .w(px(28.0))
        .h(px(16.0))
        .flex_none()
        .p(px(2.0))
        .rounded_full()
        .cursor_pointer()
        .bg(if on {
            p.c(Token::Primary)
        } else {
            p.c(Token::Input)
        })
        .flex()
        .when(on, |d| d.justify_end())
        .child(
            div()
                .size(px(12.0))
                .rounded_full()
                .bg(p.c(Token::Background)),
        )
}

pub(super) fn checkbox(on: bool, p: &crate::theme::Palette) -> Div {
    div()
        .size(px(16.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.0))
        .border_1()
        .border_color(if on {
            p.c(Token::Primary)
        } else {
            p.c(Token::Input)
        })
        .when(on, |d| d.bg(p.c(Token::Primary)))
        .when(on, |d| {
            d.child(icon("tick02", 12.0, p.c(Token::PrimaryForeground)))
        })
}

pub(super) fn dialog_card(p: &crate::theme::Palette, width: f32) -> Div {
    overlay_surface(div().w(px(width)).max_w(relative(0.92)), 16.0, p)
        .bg(p.overlay())
        .text_color(p.c(Token::PopoverForeground))
        .flex()
        .flex_col()
}

pub(super) fn dialog_head(title: &str, description: &str, p: &crate::theme::Palette) -> Div {
    div()
        .px(px(20.0))
        .pt(px(18.0))
        .pb(px(14.0))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(
            div()
                .text_size(px(16.0))
                .font_weight(FontWeight::MEDIUM)
                .child(SharedString::from(title.to_string())),
        )
        .when(!description.is_empty(), |d| {
            d.child(
                div()
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(SharedString::from(description.to_string())),
            )
        })
}

pub(super) fn dialog_foot(
    p: &crate::theme::Palette,
    cx: &mut Context<Workspace>,
    cancel: impl Fn(&mut Workspace, &mut Context<Workspace>) + 'static,
    confirm_label: &str,
    confirm: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
    disabled: bool,
) -> Div {
    div()
        .px(px(16.0))
        .py(px(12.0))
        .flex()
        .justify_end()
        .gap(px(8.0))
        .border_t_1()
        .border_color(p.c(Token::Border))
        .bg(p.c(Token::Muted).opacity(0.5))
        .rounded_b(px(16.0))
        .child(
            outline_button("dialog-cancel", p)
                .child("取消")
                .on_click(cx.listener(move |this, _, _, cx| cancel(this, cx))),
        )
        .child(
            div()
                .id("dialog-confirm")
                .h(px(32.0))
                .px(px(12.0))
                .flex()
                .items_center()
                .rounded(px(8.0))
                .bg(p.c(Token::Primary))
                .text_color(p.c(Token::PrimaryForeground))
                .text_size(px(12.8))
                .font_weight(FontWeight::MEDIUM)
                .when(disabled, |d| d.opacity(0.5))
                .when(!disabled, |d| d.cursor_pointer())
                .child(SharedString::from(confirm_label.to_string()))
                .on_click(cx.listener(move |this, _, window, cx| {
                    if !disabled {
                        confirm(this, window, cx)
                    }
                })),
        )
}

/// A dialog over the whole window, on a dimmed backdrop that closes it when clicked.
pub(super) fn modal(
    body: Div,
    p: &crate::theme::Palette,
    cx: &mut Context<Workspace>,
    close: impl Fn(&mut Workspace) + 'static,
) -> AnyElement {
    let _ = p;
    div()
        .id("modal-backdrop")
        .absolute()
        .inset_0()
        .bg(hsla(0.0, 0.0, 0.0, 0.18))
        .flex()
        .items_center()
        .justify_center()
        .on_click(cx.listener(move |this, _, _, cx| {
            close(this);
            cx.notify();
        }))
        .child(
            div()
                .id("modal-body")
                // Clicks inside the dialog are its own.
                .on_click(|_, _, cx| cx.stop_propagation())
                .child(body),
        )
        .into_any_element()
}

/// `128000` → `128K`, `1000000` → `1M`.
fn compact_tokens(n: u32) -> String {
    if n >= 1_000_000 && n.is_multiple_of(1_000_000) {
        format!("{}M", n / 1_000_000)
    } else if n >= 1_000_000 {
        format!("{:.1}M", f64::from(n) / 1_000_000.0)
    } else if n >= 1000 {
        format!("{}K", n / 1000)
    } else {
        n.to_string()
    }
}
