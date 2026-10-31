//! Protocol-backed settings: providers, general preferences, personalization, archived chats,
//! skills, MCP, memory, browser, proxy, computer control and import previews are connected.
//! Remote and SSH sections remain reserved for the redesigned remote phase.

use std::collections::HashSet;

use crate::ui::px;
use fv_protocol::methods::*;
use fv_protocol::types::Empty;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::component::input::InputState;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

#[path = "settings_account.rs"]
mod account_configuration;
#[path = "settings_configuration.rs"]
mod configuration;
#[path = "onboarding.rs"]
mod onboarding;
#[cfg(test)]
#[path = "settings_onboarding_tests.rs"]
mod onboarding_tests;
#[path = "settings_remote.rs"]
mod remote_configuration;
#[path = "settings_ssh.rs"]
mod ssh_configuration;

use super::composer::thinking_label_in;
use super::model_menu::{
    group_holds_current, model_display_name, model_row, provider_groups, provider_row,
};
use super::sidebar::INSET;
use super::{Workspace, text};
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon, icon_button_xs};
use onboarding::protocol_example;

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

/// Whether this platform shows a pane at all.
///
/// 电脑操控 needs the desktop-control driver, which has no Linux build, so on Linux there is no
/// pane to open. `fv-server` withholds the basic `computer` fallback tool on the same reading
/// (`computer::keep_basic_computer_tool`), so nothing desktop-shaped is left that a switch nobody
/// can reach would have governed.
pub fn section_available(section: Section, os: &str) -> bool {
    section != Section::Computer || computer_control_supported(os)
}

/// Every pane in the table, in navigation order — what `section_available` filters.
pub fn all_sections() -> Vec<Section> {
    SECTIONS
        .iter()
        .flat_map(|(_, items)| items.iter())
        .map(|(section, _, _)| *section)
        .collect()
}

fn section_label(section: Section) -> &'static str {
    SECTIONS
        .iter()
        .flat_map(|(_, items)| items.iter())
        .find(|(s, _, _)| *s == section)
        .map(|(_, l, _)| *l)
        .unwrap_or("")
}

/// A pane's icon, as the settings list draws it.
pub(super) fn section_icon(section: Section) -> &'static str {
    SECTIONS
        .iter()
        .flat_map(|(_, items)| items.iter())
        .find(|(s, _, _)| *s == section)
        .map(|(_, _, glyph)| *glyph)
        .unwrap_or("settings02")
}

pub(super) fn section_label_for(section: Section, language: UiLanguage) -> &'static str {
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
    /// Optional escape hatch when a provider does not expose a model listing endpoint.
    pub manual_model: Entity<InputState>,
    pub protocol: ApiProtocol,
    pub protocol_menu: bool,
    pub busy: bool,
    pub error: Option<String>,
    /// Last request used to populate the picker, so a failed fetch can be retried in place.
    pub fetch_params: Option<FetchModelsParams>,
    pub picker: Option<Picker>,
}

/// 管理模型: the models a saved provider offers, to add more of them.
pub struct AddModels {
    pub busy: bool,
    pub provider_id: String,
    pub picker: Picker,
    pub manual_model: Entity<InputState>,
}

pub struct BrowserSettings {
    pub homepage: Entity<InputState>,
    pub search_engine: Entity<InputState>,
    pub download_dir: Entity<InputState>,
}

/// 网络代理, edited as Electron edits it: a switch, then protocol, host and port. The server
/// keeps one `proxy_url`; empty means direct.
pub struct ProxySettings {
    pub enabled: bool,
    pub protocol: &'static str,
    pub host: Entity<InputState>,
    pub port: Entity<InputState>,
    pub protocol_menu: bool,
}

/// `scheme://host:port` → its parts; anything unreadable falls back to an empty HTTP proxy.
fn split_proxy_url(url: &str) -> (&'static str, String, String) {
    let (scheme, rest) = url.split_once("://").unwrap_or(("http", url));
    let protocol = PROXY_PROTOCOLS
        .iter()
        .copied()
        .find(|p| p.eq_ignore_ascii_case(scheme))
        .unwrap_or("http");
    let rest = rest.trim_end_matches('/');
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            (h.to_string(), p.to_string())
        }
        _ => (rest.to_string(), String::new()),
    };
    (protocol, host, port)
}

const PROXY_PROTOCOLS: [&str; 3] = ["http", "https", "socks5"];

#[derive(Default)]
pub struct ImportSettings {
    pub generation: u64,
    pub candidates: Option<Vec<ImportCandidate>>,
    pub busy: bool,
    pub notice: Option<String>,
    /// The source whose session picker is open (`claude-code`, `codex`, …).
    pub picking: Option<String>,
    /// Session ids ticked in that picker.
    pub selected: HashSet<String>,
    pub importing: bool,
    /// Electron migration is a read-only preflight followed by an explicit commit.
    pub migration: Option<fv_protocol::migration::ElectronMigrationScanResponse>,
    pub migration_busy: bool,
    pub migration_include_api_keys: bool,
    pub migration_overwrite_settings: bool,
    pub migration_notice: Option<String>,
}

impl ImportSettings {
    /// Dev capture: a few sessions from two agents, the second one's picker open.
    pub fn sample_for_capture(&mut self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let make = |source: &str, id: &str, title: &str, n: usize| ImportCandidate {
            source: source.into(),
            source_id: id.into(),
            title: title.into(),
            cwd: Some("~/code/fastvibe".into()),
            created_at: now,
            updated_at: now,
            message_count: n,
            bytes: 0,
        };
        self.candidates = Some(vec![
            make("claude-code", "c1", "修复消息队列重复发送", 42),
            make("claude-code", "c2", "梳理 pi 扩展的加载流程", 18),
            make("codex", "x1", "Add dark mode toggle", 12),
            make("codex", "x2", "Refactor the settings store", 30),
        ]);
        self.busy = false;
        self.generation = self.generation.wrapping_add(1);
        self.picking = Some("codex".into());
        self.selected.insert("x1".into());
    }
}

impl ProxySettings {
    fn new(settings: &AppSettings, _english: bool, window: &mut Window, cx: &mut App) -> Self {
        let url = settings.proxy_url.trim();
        let (protocol, host_value, port_value) = split_proxy_url(url);
        let host = input(window, cx, "127.0.0.1", false);
        host.update(cx, |state, cx| state.set_value(host_value, window, cx));
        let port = input(window, cx, "7890", false);
        port.update(cx, |state, cx| state.set_value(port_value, window, cx));
        Self {
            enabled: !url.is_empty(),
            protocol,
            host,
            port,
            protocol_menu: false,
        }
    }

    /// What the form says, as the one URL the server stores.
    fn url(&self, cx: &App) -> String {
        if !self.enabled {
            return String::new();
        }
        let host = value(&self.host, cx);
        let port = value(&self.port, cx);
        if port.is_empty() {
            format!("{}://{host}", self.protocol)
        } else {
            format!("{}://{host}:{port}", self.protocol)
        }
    }

    fn host_valid(&self, cx: &App) -> bool {
        let host = value(&self.host, cx);
        !host.is_empty() && !host.contains("://") && !host.contains(['/', '@', ' '])
    }

    fn port_valid(&self, cx: &App) -> bool {
        value(&self.port, cx)
            .parse::<u32>()
            .is_ok_and(|p| (1..=65535).contains(&p))
    }
}

impl BrowserSettings {
    fn new(settings: &AppSettings, english: bool, window: &mut Window, cx: &mut App) -> Self {
        Self {
            homepage: input(
                window,
                cx,
                trs!(english, "settings.about_blank_or_https"),
                false,
            ),
            search_engine: input(window, cx, "https://…/?q={query}", false),
            download_dir: input(
                window,
                cx,
                trs!(english, "settings.leave_empty_for_downloads"),
                false,
            ),
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
    AiLanguage,
    AutoArchive,
    Mode,
    Light,
    Dark,
    FontSize,
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
    /// Which provider's models stand beside the 默认模型 menu — Electron nests them one level in.
    pub default_provider_menu: Option<String>,
    /// The 推理强度 flyout beside `default_menu`, matching Electron's submenu.
    pub default_thinking_menu: bool,
    pub search: Entity<InputState>,
    pub add: Option<AddProvider>,
    pub add_models: Option<AddModels>,
    pub notice: Option<String>,
    pub cc_switch: Option<fv_protocol::types::ProviderImportScan>,
    pub cc_switch_selected: HashSet<String>,
    pub cc_switch_busy: bool,
    pub project_defaults: Option<(String, ModelDefaults)>,
    account: account_configuration::AccountSettings,
    remote: remote_configuration::RemoteSettings,
    ssh: ssh_configuration::SshSettings,
    pub project_defaults_request: u64,
    pub project_defaults_busy: bool,
    pub success: Option<String>,
    pub default_saving: bool,
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
            let english = self.app_settings.language == UiLanguage::English;
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
                browser: BrowserSettings::new(&self.app_settings, english, window, cx),
                proxy: ProxySettings::new(&self.app_settings, english, window, cx),
                import: ImportSettings::default(),
                section,
                providers: None,
                edit: None,
                default_menu: false,
                default_provider_menu: None,
                default_thinking_menu: false,
                theme_menu: None,
                archived: None,
                confirm_delete: None,
                search: input(
                    window,
                    cx,
                    trs!(english, "settings.search_providers_or_models"),
                    false,
                ),
                add: None,
                add_models: None,
                notice: None,
                cc_switch: None,
                cc_switch_selected: HashSet::new(),
                cc_switch_busy: false,
                project_defaults: None,
                account: account_configuration::AccountSettings::new(window, cx),
                remote: remote_configuration::RemoteSettings::new(window, cx),
                ssh: ssh_configuration::SshSettings::new(window, cx),
                project_defaults_request: 0,
                project_defaults_busy: false,
                success: None,
                default_saving: false,
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
                s.account.pause();
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
        if section == Section::Browser {
            self.refresh_browser_profiles(cx);
        }
        if section == Section::Remote {
            self.refresh_remote_settings(cx);
            self.refresh_account_settings(window, cx);
            self.start_account_status_poll(window, cx);
        }
        if section == Section::Ssh {
            self.refresh_ssh_settings(cx);
        }
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
                let english = this.english();
                if let Some(settings) = this
                    .settings
                    .as_mut()
                    .filter(|settings| settings.import.generation == generation)
                {
                    settings.import.busy = false;
                    match result {
                        Ok(response) => settings.import.candidates = Some(response.candidates),
                        Err(error) => {
                            settings.import.notice = Some(tr!(
                                english,
                                "settings.could_not_read_import_candidates",
                                error = error
                            ))
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Copy every ticked session of the open picker into FastVibe, one after another, then
    /// close the picker and say how it went. The chats stay where they are: an import of twelve
    /// sessions must not walk the user through twelve conversations.
    fn import_selected(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(settings) = self.settings.as_mut() else {
            return;
        };
        let Some(source) = settings.import.picking.clone() else {
            return;
        };
        let picked: Vec<ImportCandidate> = settings
            .import
            .candidates
            .iter()
            .flatten()
            .filter(|c| c.source == source && settings.import.selected.contains(&c.source_id))
            .cloned()
            .collect();
        if picked.is_empty() {
            return;
        }
        settings.import.importing = true;
        settings.import.notice = None;
        cx.spawn(async move |this, cx| {
            let (mut ok, mut failed) = (0usize, Vec::new());
            for candidate in picked {
                match backend
                    .call::<ImportCommit>(ImportCommitParams {
                        source: candidate.source,
                        source_id: candidate.source_id,
                    })
                    .await
                {
                    Ok(_) => ok += 1,
                    Err(error) => failed.push(error.to_string()),
                }
            }
            this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(settings) = &mut this.settings {
                    let import = &mut settings.import;
                    import.importing = false;
                    import.picking = None;
                    import.selected.clear();
                    let mut notice = tr!(english, "settings.import_done", ok = ok);
                    if !failed.is_empty() {
                        notice.push_str(&tr!(
                            english,
                            "settings.import_done_failed",
                            failed = failed.len()
                        ));
                    }
                    import.notice = Some(notice);
                }
                this.refresh_threads(cx);
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
                let english = this.english();
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner && s.provider_request == request)
                {
                    match result {
                        Ok(r) => s.providers = Some(r.providers),
                        Err(e) => {
                            s.notice =
                                Some(tr!(english, "settings.could_not_read_providers_e", e = e))
                        }
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
                let english = this.english();
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| Some(s.search.entity_id()) == owner)
                {
                    match result {
                        Ok(_) => {
                            s.notice = None;
                            s.success = Some(trs!(english, "settings.saved").into());
                            if let Some((key_owner, raw)) = key_draft
                                && let Some(edit) =
                                    s.edit.as_mut().filter(|e| e.key.entity_id() == key_owner)
                            {
                                edit.clear_key_after_save = Some(raw);
                            }
                        }
                        Err(e) => s.notice = Some(tr!(english, "settings.save_failed_e", e = e)),
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
        if self.settings.as_ref().is_some_and(|s| s.default_saving) {
            return;
        }
        let Some(b) = self.backend.clone() else {
            return;
        };
        if let Some(s) = &mut self.settings {
            s.default_saving = true;
            s.notice = None;
            s.success = Some(
                trs!(
                    self.app_settings.language == UiLanguage::English,
                    "settings.saving"
                )
                .into(),
            );
            s.default_menu = false;
            s.default_provider_menu = None;
            s.default_thinking_menu = false;
            self.hover_submenus.entered();
        }
        let owner = self.settings.as_ref().map(|s| s.search.entity_id());
        let call = b.call::<ModelDefaultsSet>(defaults);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                let english = this.english();
                match result {
                    Ok(d) => {
                        this.defaults = d;
                        if let Some(s) = this
                            .settings
                            .as_mut()
                            .filter(|s| Some(s.search.entity_id()) == owner)
                        {
                            s.default_saving = false;
                            s.success = Some(trs!(english, "settings.saved").into());
                        }
                    }
                    Err(e) => {
                        if let Some(s) = this
                            .settings
                            .as_mut()
                            .filter(|s| Some(s.search.entity_id()) == owner)
                        {
                            s.default_saving = false;
                            s.success = None;
                            s.notice = Some(tr!(english, "settings.save_failed_e", e = e));
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Close a hover submenu shortly after the pointer leaves its trigger. The short grace
    /// period lets the pointer cross the 12px overlap into the sibling flyout; entering either
    /// surface increments the generation and cancels this pending close.
    fn close_default_submenu_after_hover(&mut self, cx: &mut Context<Self>) {
        self.hover_submenus.close_after(cx, |this| {
            if let Some(settings) = &mut this.settings
                && (settings.default_provider_menu.is_some() || settings.default_thinking_menu)
            {
                settings.default_provider_menu = None;
                settings.default_thinking_menu = false;
            }
        });
    }

    fn toggle_provider(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let english = self.english();
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
                trs!(english, "settings.saved_enter_a_new_key")
            } else {
                trs!(english, "settings.paste_the_api_key")
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
        let english = self.english();
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
                picker.error =
                    Some(trs!(english, "settings.not_connected_to_the_service").to_string());
            }
            if let Some(a) = self.settings.as_mut().and_then(|s| s.add.as_mut()) {
                a.busy = false;
            }
            cx.notify();
            return;
        };
        if let Some(a) = self
            .settings
            .as_mut()
            .and_then(|s| s.add.as_mut())
            .filter(|a| {
                a.picker
                    .as_ref()
                    .is_some_and(|p| p.search.entity_id() == owner)
            })
        {
            a.fetch_params = Some(params.clone());
            a.busy = true;
            a.error = None;
            if let Some(picker) = &mut a.picker {
                picker.error = None;
            }
        }
        let call = b.call::<ProviderFetchModels>(params);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(s) = &mut this.settings {
                    let is_add = s
                        .add
                        .as_ref()
                        .and_then(|a| a.picker.as_ref())
                        .is_some_and(|p| p.search.entity_id() == owner);
                    if let Some(picker) = target(s).filter(|p| p.search.entity_id() == owner) {
                        match result {
                            Ok(r) => {
                                picker.models = Some(r.models);
                                picker.error = None;
                            }
                            Err(e) => {
                                if picker.models.is_none() {
                                    picker.models = Some(Vec::new());
                                }
                                let message =
                                    tr!(english, "settings.could_not_fetch_the_model", e = e);
                                picker.error = Some(message.clone());
                                if is_add && let Some(a) = &mut s.add {
                                    a.error = Some(message);
                                }
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
        let search = input(
            window,
            cx,
            if self.app_settings.language == UiLanguage::English {
                "Search models"
            } else {
                "搜索模型"
            },
            false,
        );
        let manual_model = input(
            window,
            cx,
            trs!(self.english(), "settings.manual_model_id"),
            false,
        );
        let Some(s) = &mut self.settings else { return };
        let existing = s
            .providers
            .as_ref()
            .and_then(|list| list.iter().find(|p| p.id == provider_id))
            .map(|p| p.models.clone())
            .unwrap_or_default();
        let chosen = existing.iter().map(|m| m.id.clone()).collect();
        s.add_models = Some(AddModels {
            busy: false,
            provider_id: provider_id.clone(),
            manual_model,
            picker: Picker {
                models: Some(existing),
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
        let english = self.app_settings.language == UiLanguage::English;
        let add = AddProvider {
            name: input(window, cx, trs!(english, "settings.e_g_openrouter"), false),
            base_url: input(window, cx, "https://api.example.com/v1", false),
            key: input(
                window,
                cx,
                trs!(english, "settings.paste_this_provider_s_api"),
                true,
            ),
            manual_model: input(window, cx, trs!(english, "settings.manual_model_id"), false),
            protocol: ApiProtocol::Chat,
            protocol_menu: false,
            busy: false,
            error: None,
            fetch_params: None,
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
            self.add_error(trs!(self.english(), "settings.enter_name_url_key"), cx);
            return;
        }
        let search = input(
            window,
            cx,
            if self.app_settings.language == UiLanguage::English {
                "Search models"
            } else {
                "搜索模型"
            },
            false,
        );
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
        if self
            .settings
            .as_ref()
            .and_then(|s| s.add.as_ref())
            .is_some_and(|a| !value(&a.manual_model, cx).is_empty())
        {
            if let Some(a) = self.settings.as_mut().and_then(|s| s.add.as_mut()) {
                a.busy = false;
                if let Some(picker) = &mut a.picker {
                    picker.models = Some(Vec::new());
                }
            }
            self.finish_add_provider(cx);
            return;
        }
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
            self.add_error(
                trs!(self.english(), "settings.not_connected_to_the_service"),
                cx,
            );
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
        let mut models: Vec<ModelInfo> = picker
            .models
            .iter()
            .flatten()
            .filter(|m| picker.chosen.contains(&m.id))
            .cloned()
            .collect();
        if let Some(model) = onboarding::manual_model(&value(&a.manual_model, cx))
            && !models.iter().any(|existing| existing.id == model.id)
        {
            models.push(model);
        }
        if models.is_empty() {
            self.add_error(
                trs!(self.english(), "settings.select_at_least_one_model"),
                cx,
            );
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
                let english = this.english();
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
                            a.error = Some(tr!(english, "settings.save_failed_e", e = e));
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
        let mut chosen = am.picker.chosen.clone();
        let mut fetched = am.picker.models.clone().unwrap_or_default();
        if let Some(model) = onboarding::manual_model(&value(&am.manual_model, cx)) {
            chosen.insert(model.id.clone());
            if !fetched.iter().any(|existing| existing.id == model.id) {
                fetched.push(model);
            }
        }
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
                let english = this.english();
                if let Some(s) = this.settings.as_mut()
                    && let Some(am) = s
                        .add_models
                        .as_mut()
                        .filter(|a| a.picker.search.entity_id() == owner)
                {
                    am.busy = false;
                    match result {
                        Ok(_) => {
                            if am.picker.chosen.iter().all(|id| chosen.contains(id)) {
                                s.add_models = None;
                            }
                            s.success = Some(trs!(english, "settings.saved").into());
                        }
                        Err(error) => {
                            am.picker.error = Some(tr!(
                                english,
                                "settings.save_failed_your_selection_was",
                                error = error
                            ))
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
            .child(self.settings_nav(s, window, cx))
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
                            // 使用统计 draws its own header (title + 应用用量 pill), as Electron's does.
                            .when(s.section != Section::Usage, |d| {
                                d.child(
                                    div()
                                        .text_size(px(20.0))
                                        .line_height(px(28.0))
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(section_label_for(
                                            s.section,
                                            self.app_settings.language,
                                        )),
                                )
                            })
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
                                Section::Remote => self.remote_settings_pane(s, cx),
                                Section::Ssh => self.render_settings_ssh(s, cx),
                            }),
                    ),
            )
            .into_any_element()
    }

    /// The settings list takes the shell sidebar's own width, as Electron's aside does.
    fn settings_nav_width(&self, window: &Window) -> f32 {
        self.sidebar_resting_width(f32::from(window.viewport_size().width))
    }

    fn settings_nav(
        &self,
        s: &SettingsState,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = &self.palette;
        let language = self.app_settings.language;
        let hover = ui::half(p.c(Token::SidebarAccent));
        let foreground = p.c(Token::Foreground);
        let mut list = div().px(px(8.0)).pb(px(12.0)).flex().flex_col();
        for (gi, (group, items)) in SECTIONS.iter().enumerate() {
            // A group whose every pane this platform hides keeps no heading of its own.
            let visible: Vec<&SectionItem> = items
                .iter()
                .filter(|(section, _, _)| section_available(*section, std::env::consts::OS))
                .collect();
            if visible.is_empty() {
                continue;
            }
            list = list.child(
                div()
                    .when(gi > 0, |d| d.mt(px(12.0)))
                    .px(px(8.0))
                    .pb(px(4.0))
                    .text_size(px(TEXT_XS))
                    .line_height(px(16.0))
                    .font_weight(FontWeight::MEDIUM)
                    .muted(p)
                    .child(section_group_label(group, language)),
            );
            for (section, label, glyph) in visible {
                let section = *section;
                let active = s.section == section;
                list = list.child(
                    div()
                        .id(SharedString::from(format!("settings-{label}")))
                        .h(px(32.0))
                        .mb(px(2.0))
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
                        .child(icon(glyph, 16.0, p.c(Token::MutedForeground)))
                        .child(section_label_for(section, language))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_settings(section, window, cx)
                        })),
                );
            }
        }
        div()
            .w(px(self.settings_nav_width(window)))
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
                        div().px(px(8.0)).pt(px(4.0)).flex_none().child(
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
                                .muted(p)
                                .hover(move |d| d.bg(hover).text_color(foreground))
                                .child(icon("arrow-left01", 16.0, p.c(Token::MutedForeground)))
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
                            .pt(px(12.0))
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

    /// 导入: one row per agent that has sessions on this machine, each opening a picker of
    /// its sessions; nothing is copied until the user ticks some and confirms.
    fn import_pane(&self, s: &SettingsState, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let import = &s.import;
        let candidates = import.candidates.as_deref().unwrap_or(&[]);
        let mut sources: Vec<(&str, Vec<&ImportCandidate>)> = Vec::new();
        for id in ["pi", "claude-code", "codex", "opencode", "zcode"] {
            let list: Vec<&ImportCandidate> =
                candidates.iter().filter(|c| c.source == id).collect();
            if !list.is_empty() {
                sources.push((id, list));
            }
        }
        let mut header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(SharedString::from(if import.busy {
                        trs!(english, "settings.reading").to_string()
                    } else {
                        tr!(english, "settings.import_found", count = candidates.len())
                    })),
            )
            .child(
                div()
                    .id("refresh-import-candidates")
                    .size(px(28.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(p.c(Token::Border))
                    .bg(p.c(Token::Background))
                    .cursor_pointer()
                    .child(icon("refresh", 14.0, p.c(Token::Foreground)))
                    .on_click(cx.listener(|this, _, _, cx| this.refresh_import(cx))),
            );
        if import.candidates.is_none() && import.busy {
            header = header.opacity(0.7);
        }
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .text_size(px(TEXT_SM))
                            .font_weight(FontWeight::MEDIUM)
                            .child(icon("import", 16.0, p.c(Token::Foreground)))
                            .child(trs!(english, "settings.import_title")),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .muted(p)
                            .child(trs!(english, "settings.import_desc")),
                    ),
            )
            .child(header);
        if let Some(notice) = &import.notice {
            body = body.child(div().text_size(px(TEXT_XS)).muted(p).child(notice.clone()));
        }
        if sources.is_empty() {
            if !import.busy {
                body = body.child(
                    div()
                        .py(px(24.0))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(4.0))
                        .child(
                            div()
                                .text_size(px(TEXT_SM))
                                .font_weight(FontWeight::MEDIUM)
                                .child(trs!(english, "settings.import_empty_title")),
                        )
                        .child(
                            div()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(trs!(english, "settings.import_empty_desc")),
                        ),
                );
            }
        } else {
            let mut list = div()
                .rounded(px(10.0))
                .border_1()
                .border_color(p.c(Token::Border))
                .overflow_hidden()
                .flex()
                .flex_col();
            for (i, (id, sessions)) in sources.iter().enumerate() {
                let source = id.to_string();
                let latest = sessions.iter().map(|c| c.updated_at).max().unwrap_or(0);
                let mut detail = tr!(english, "settings.import_sessions", count = sessions.len());
                if let Some(date) = month_day(latest) {
                    detail.push('·');
                    detail.push_str(&tr!(english, "settings.import_latest", date = date));
                }
                list = list.child(
                    div()
                        .px(px(12.0))
                        .py(px(10.0))
                        .flex()
                        .items_center()
                        .gap(px(12.0))
                        .when(i > 0, |d| d.border_t_1().border_color(p.c(Token::Border)))
                        .child(
                            div()
                                .size(px(32.0))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(8.0))
                                .border_1()
                                .border_color(p.c(Token::Border))
                                .bg(p.c(Token::Background))
                                .child(icon(&format!("brand-{id}"), 16.0, p.c(Token::Foreground))),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(
                                    div()
                                        .text_size(px(TEXT_SM))
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(source_name(id)),
                                )
                                .child(
                                    div()
                                        .text_size(px(TEXT_XS))
                                        .muted(p)
                                        .child(SharedString::from(detail)),
                                ),
                        )
                        .child(
                            outline_button(SharedString::from(format!("import-{id}")), p)
                                .h(px(28.0))
                                .child(trs!(english, "settings.import_action"))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(s) = &mut this.settings {
                                        let import = &mut s.import;
                                        import.picking =
                                            if import.picking.as_deref() == Some(source.as_str()) {
                                                None
                                            } else {
                                                Some(source.clone())
                                            };
                                        import.selected.clear();
                                    }
                                    cx.notify();
                                })),
                        ),
                );
                if import.picking.as_deref() == Some(*id) {
                    list = list.child(self.import_picker(id, sessions, import, cx));
                }
            }
            body = body.child(list);
        }
        div()
            .flex()
            .flex_col()
            .gap(px(20.0))
            .child(self.electron_migration_pane(s, cx))
            .child(card(p).p(px(16.0)).child(body))
            .into_any_element()
    }

    /// The sessions of one source, ticked for import.
    fn import_picker(
        &self,
        source: &str,
        sessions: &[&ImportCandidate],
        import: &ImportSettings,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let all: Vec<String> = sessions.iter().map(|c| c.source_id.clone()).collect();
        let every = !all.is_empty() && all.iter().all(|id| import.selected.contains(id));
        let count = import.selected.len();
        let hover = p.c(Token::Muted);
        let mut rows = div()
            .id(SharedString::from(format!("import-picker-{source}")))
            .max_h(px(288.0))
            .overflow_y_scroll()
            .flex()
            .flex_col();
        for c in sessions {
            let id = c.source_id.clone();
            let on = import.selected.contains(&id);
            rows = rows.child(
                div()
                    .id(SharedString::from(format!("import-pick-{id}")))
                    .px(px(12.0))
                    .py(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .cursor_pointer()
                    .hover(move |d| d.bg(hover))
                    .child(checkbox(on, p))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(ui::truncate(c.title.clone()).text_size(px(TEXT_SM)))
                            .child(
                                ui::truncate(format!(
                                    "{} · {}",
                                    tr!(
                                        english,
                                        "settings.import_messages",
                                        count = c.message_count
                                    ),
                                    c.cwd
                                        .as_deref()
                                        .unwrap_or(trs!(english, "settings.unknown_directory"))
                                ))
                                .text_size(px(TEXT_XS))
                                .muted(p),
                            ),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(s) = &mut this.settings
                            && !s.import.selected.remove(&id)
                        {
                            s.import.selected.insert(id.clone());
                        }
                        cx.notify();
                    })),
            );
        }
        let importing = import.importing;
        let disabled = importing || count == 0;
        div()
            .border_t_1()
            .border_color(p.c(Token::Border))
            .bg(ui::half(p.c(Token::Muted)))
            .flex()
            .flex_col()
            .child(
                div()
                    .id(SharedString::from(format!("import-all-{source}")))
                    .px(px(12.0))
                    .py(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .cursor_pointer()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(checkbox(every, p))
                    .child(SharedString::from(tr!(
                        english,
                        "settings.import_select_all",
                        selected = count,
                        total = all.len()
                    )))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(s) = &mut this.settings {
                            if every {
                                s.import.selected.clear();
                            } else {
                                s.import.selected = all.iter().cloned().collect();
                            }
                        }
                        cx.notify();
                    })),
            )
            .child(rows)
            .child(
                div()
                    .px(px(12.0))
                    .py(px(8.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(trs!(english, "settings.import_pick_hint")),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("import-run-{source}")))
                            .h(px(28.0))
                            .px(px(10.0))
                            .flex()
                            .items_center()
                            .rounded(px(8.0))
                            .bg(p.c(Token::Primary))
                            .text_color(p.c(Token::PrimaryForeground))
                            .text_size(px(TEXT_XS))
                            .font_weight(FontWeight::MEDIUM)
                            .when(disabled, |d| d.opacity(0.5))
                            .when(!disabled, |d| d.cursor_pointer())
                            .child(SharedString::from(if importing {
                                trs!(english, "settings.import_importing").to_string()
                            } else {
                                tr!(english, "settings.import_count", count = count)
                            }))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !disabled {
                                    this.import_selected(cx);
                                }
                            })),
                    ),
            )
    }

    fn retry_provider_fetch(&mut self, cx: &mut Context<Self>) {
        let Some(params) = self
            .settings
            .as_ref()
            .and_then(|s| s.add.as_ref())
            .and_then(|a| a.fetch_params.clone())
        else {
            return;
        };
        self.fetch_into(
            params,
            |s| s.add.as_mut().and_then(|a| a.picker.as_mut()),
            cx,
        );
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
        let field = |state: &Entity<InputState>| div().w(px(288.0)).child(ui::input(state));
        let controls = self.browser_control_settings(cx);
        let changed = value(&s.browser.homepage, cx) != self.app_settings.browser_homepage
            || value(&s.browser.search_engine, cx) != self.app_settings.browser_search_engine
            || value(&s.browser.download_dir, cx) != self.app_settings.browser_download_dir;
        div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .px(px(4.0))
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(trs!(english, "settings.browser_control")),
            )
            .child(controls)
            .child(
                card(p)
                    .child(setting_row(
                        trs!(english, "settings.home_page"),
                        trs!(english, "settings.home_page_desc"),
                        false,
                        p,
                        field(&s.browser.homepage),
                    ))
                    .child(setting_row(
                        trs!(english, "settings.search_url_template"),
                        trs!(english, "settings.the_template_must_contain_query"),
                        true,
                        p,
                        field(&s.browser.search_engine),
                    ))
                    .child(setting_row(
                        trs!(english, "settings.download_directory"),
                        trs!(english, "settings.leave_empty_to_use_the"),
                        true,
                        p,
                        field(&s.browser.download_dir),
                    ))
                    .child(setting_row(
                        trs!(english, "settings.proxy_apply_title"),
                        "",
                        true,
                        p,
                        outline_button("save-browser-settings", p)
                            .h(px(28.0))
                            .when(!changed, |d| d.opacity(0.5).cursor_default())
                            .child(trs!(english, "settings.save"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if changed {
                                    this.save_browser(cx)
                                }
                            })),
                    )),
            )
            .into_any_element()
    }

    fn computer_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        self.computer_pane_view(cx)
    }

    fn save_proxy(&mut self, cx: &mut Context<Self>) {
        let Some(settings) = self.settings.as_ref() else {
            return;
        };
        self.patch_settings(
            AppSettingsPatch {
                proxy_url: Some(settings.proxy.url(cx)),
                ..Default::default()
            },
            cx,
        );
    }

    fn proxy_pane(&self, s: &SettingsState, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let proxy = &s.proxy;
        let enabled = proxy.enabled;
        let hover = p.c(Token::Accent);
        let host_valid = proxy.host_valid(cx);
        let port_valid = proxy.port_valid(cx);
        let changed = proxy.url(cx) != self.app_settings.proxy_url.trim();
        let can_apply = changed && (!enabled || (host_valid && port_valid));
        let mut card = card(p).child(setting_row(
            trs!(english, "settings.proxy_enabled"),
            trs!(english, "settings.proxy_scope"),
            false,
            p,
            switch(SharedString::from("proxy-enabled"), enabled, p).on_click(cx.listener(
                |this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        s.proxy.enabled = !s.proxy.enabled;
                    }
                    cx.notify();
                },
            )),
        ));
        if enabled {
            let mut menu = popover(p)
                .absolute()
                .top(px(34.0))
                .right(px(0.0))
                .w(px(144.0));
            for protocol in PROXY_PROTOCOLS {
                menu = menu.child(
                    menu_item(
                        SharedString::from(format!("proxy-protocol-{protocol}")),
                        proxy.protocol == protocol,
                        hover,
                    )
                    .child(protocol.to_uppercase())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(s) = &mut this.settings {
                            s.proxy.protocol = protocol;
                            s.proxy.protocol_menu = false;
                        }
                        cx.notify();
                    })),
                );
            }
            let protocol_button = outline_button("proxy-protocol", p)
                .w(px(144.0))
                .h(px(30.0))
                .justify_between()
                .rounded(px(8.0))
                .font_weight(FontWeight::NORMAL)
                .text_size(px(TEXT_SM))
                .child(proxy.protocol.to_uppercase())
                .child(icon("unfold-more", 14.0, p.c(Token::MutedForeground)))
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        s.proxy.protocol_menu = !s.proxy.protocol_menu;
                    }
                    cx.notify();
                }));
            let host_hint = if host_valid || value(&proxy.host, cx).is_empty() {
                trs!(english, "settings.proxy_host_hint")
            } else {
                trs!(english, "settings.proxy_invalid_host")
            };
            let port_hint = if port_valid || value(&proxy.port, cx).is_empty() {
                ""
            } else {
                trs!(english, "settings.proxy_invalid_port")
            };
            card = card
                .child(setting_row(
                    trs!(english, "settings.proxy_protocol"),
                    "",
                    true,
                    p,
                    div()
                        .relative()
                        .child(protocol_button)
                        .when(proxy.protocol_menu, |d| d.child(ui::float(menu))),
                ))
                .child(setting_row(
                    trs!(english, "settings.proxy_host"),
                    host_hint,
                    true,
                    p,
                    div().w(px(144.0)).child(ui::input(&proxy.host)),
                ))
                .child(setting_row(
                    trs!(english, "settings.proxy_port"),
                    port_hint,
                    true,
                    p,
                    div().w(px(144.0)).child(ui::input(&proxy.port)),
                ));
        }
        card = card.child(setting_row(
            trs!(english, "settings.proxy_apply_title"),
            trs!(english, "settings.proxy_limits"),
            true,
            p,
            outline_button("save-proxy", p)
                .h(px(28.0))
                .when(!can_apply, |d| d.opacity(0.5).cursor_default())
                .child(trs!(english, "settings.proxy_apply"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if can_apply {
                        this.save_proxy(cx)
                    }
                })),
        ));
        div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .px(px(4.0))
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(trs!(english, "settings.network_proxy")),
            )
            .child(card)
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
            None => trs!(english, "settings.not_set").to_string(),
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
            .map(|level| thinking_label_in(level, english))
            .unwrap_or(trs!(english, "settings.follow_model_default"));
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
                            .child(trs!(english, "settings.conversation_model")),
                    )
                    .child(
                        div()
                            .mt(px(2.0))
                            .text_size(px(TEXT_XS))
                            .line_height(px(16.0))
                            .muted(p)
                            .child(trs!(english, "settings.new_chats_use_this_model")),
                    ),
            )
            .child(
                outline_button("default-model", p)
                    .h(px(30.0))
                    .rounded(px(8.0))
                    .font_weight(FontWeight::NORMAL)
                    .text_size(px(TEXT_SM))
                    .child(SharedString::from(current))
                    .child(div().muted(p).child(SharedString::from(thinking)))
                    .child(icon("arrow-down01", 12.0, p.c(Token::MutedForeground)))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(s) = &mut this.settings {
                            s.default_menu = !s.default_menu;
                            if !s.default_menu {
                                s.default_provider_menu = None;
                                s.default_thinking_menu = false;
                            }
                            this.hover_submenus.entered();
                        }
                        cx.notify();
                    })),
            )
            .when(s.default_menu, |d| {
                d.child(ui::float(self.default_menu(cx)))
                    .when(s.default_provider_menu.is_some(), |d| {
                        d.child(
                            deferred(self.default_provider_flyout(window, cx).occlude())
                                .with_priority(11),
                        )
                    })
                    .when(s.default_thinking_menu, |d| {
                        // Its own float: a child of the parent popover is clipped to that
                        // card, so the glass fill never covers the page and the text shows through.
                        d.child(
                            deferred(self.thinking_flyout(window, cx).occlude()).with_priority(11),
                        )
                    })
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
                    .child(trs!(english, "settings.providers"))
                    .child(div().muted(p).child(SharedString::from(count.to_string()))),
            )
            .child(
                outline_button("add-provider", p)
                    .child(icon("add01", 14.0, p.c(Token::Foreground)))
                    .child(trs!(english, "settings.add_provider"))
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
                        .child(trs!(english, "settings.loading_providers")),
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
                                .child(trs!(english, "settings.add_your_first_provider")),
                        )
                        .child(
                            div()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(trs!(english, "settings.onboarding_provider_hint")),
                        )
                        .child(
                            div()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(trs!(english, "settings.connect_an_api_key_and")),
                        ),
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
        if let Some(message) = &s.success {
            col = col.child(div().text_size(px(TEXT_SM)).muted(p).child(message.clone()));
        }
        if let Some(n) = &s.notice {
            col = col.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(TEXT_SM))
                    .text_color(p.c(Token::Destructive))
                    .child(SharedString::from(n.clone()))
                    .child(
                        outline_button("retry-provider-list", p)
                            .h(px(28.0))
                            .child(trs!(english, "settings.retry"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(s) = &mut this.settings {
                                    s.notice = None;
                                }
                                this.refresh_providers(cx);
                            })),
                    ),
            );
        }
        let provider_setup = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(header)
            .child(ui::input(&s.search).prefix(icon("search01", 14.0, p.c(Token::MutedForeground))))
            .child(list);
        if self.models.is_empty() {
            col.child(provider_setup).child(self.cc_switch_pane(s, cx))
        } else {
            col.child(card(p).child(default_row))
                .child(provider_setup)
                .child(self.project_defaults_pane(s, cx))
                .child(self.cc_switch_pane(s, cx))
        }
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
            (SandboxMode::ReadOnly, trs!(english, "settings.read_only")),
            (
                SandboxMode::WorkspaceWrite,
                trs!(english, "settings.workspace_write"),
            ),
            (
                SandboxMode::DangerFullAccess,
                trs!(english, "settings.full_access"),
            ),
        ];
        let policies: [(ApprovalPolicy, &str); 4] = [
            (
                ApprovalPolicy::OnRequest,
                trs!(english, "settings.ask_when_needed"),
            ),
            (
                ApprovalPolicy::OnFailure,
                trs!(english, "settings.ask_after_failure"),
            ),
            (
                ApprovalPolicy::Untrusted,
                trs!(english, "settings.ask_for_untrusted"),
            ),
            (ApprovalPolicy::Never, trs!(english, "settings.never_ask")),
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
            .top(px(34.0))
            .right(px(0.0))
            .w(px(176.0));
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
            .top(px(34.0))
            .right(px(0.0))
            .w(px(176.0));
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
                trs!(english, "settings.commands_can_read_but_cannot")
            }
            SandboxMode::WorkspaceWrite => {
                trs!(english, "settings.commands_can_read_anywhere_but")
            }
            SandboxMode::DangerFullAccess => {
                trs!(english, "settings.commands_have_no_restrictions_use")
            }
        };
        let policy_note = match a.approval_policy {
            ApprovalPolicy::OnRequest => {
                trs!(english, "settings.commands_run_in_the_sandbox")
            }
            ApprovalPolicy::OnFailure => {
                trs!(english, "settings.commands_run_in_the_sandbox_2")
            }
            ApprovalPolicy::Untrusted => {
                trs!(english, "settings.ask_first_except_for_known")
            }
            ApprovalPolicy::Never => {
                trs!(english, "settings.never_ask_a_sandbox_block")
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
                    .child(trs!(english, "settings.sandbox_approvals")),
            )
            .child(
                card(p)
                    .child(setting_row(
                        trs!(english, "settings.sandbox_mode"),
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
                        trs!(english, "settings.approval_policy"),
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
                        trs!(english, "settings.allow_network_access"),
                        if network_usable {
                            trs!(english, "settings.sandboxed_commands_can_access_the")
                        } else {
                            trs!(english, "settings.only_applies_to_workspace_write")
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
        let auto_review_approvals = a.auto_review_approvals;
        let code_mode_enabled = a.code_mode_enabled;
        let keep_awake = a.keep_awake;
        let english = a.language == UiLanguage::English;
        let hover = p.c(Token::Accent);
        let language_label = |language: UiLanguage| match language {
            UiLanguage::Chinese => "简体中文",
            UiLanguage::English => "English",
        };
        let mode_label = |m: ThemeMode| match m {
            ThemeMode::System => {
                trs!(english, "settings.system")
            }
            ThemeMode::Light => {
                trs!(english, "settings.light")
            }
            ThemeMode::Dark => {
                trs!(english, "settings.dark")
            }
        };
        let select =
            |id: &'static str, which: ThemeMenu, content: AnyElement, cx: &mut Context<Self>| {
                outline_button(id, p)
                    .w(px(176.0))
                    .h(px(30.0))
                    .justify_between()
                    .rounded(px(8.0))
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
            .top(px(34.0))
            .right(px(0.0))
            .w(px(176.0));
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
            .top(px(34.0))
            .right(px(0.0))
            .w(px(176.0));
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

        let mut font_size_menu = popover(p)
            .absolute()
            .top(px(34.0))
            .right(px(0.0))
            .w(px(176.0));
        for size in 12u32..=20 {
            font_size_menu = font_size_menu.child(
                menu_item(
                    SharedString::from(format!("font-size-{size}")),
                    a.ui_font_size == size,
                    hover,
                )
                .child(SharedString::from(format!("{size}px")))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        s.theme_menu = None;
                    }
                    this.patch_settings(
                        AppSettingsPatch {
                            ui_font_size: Some(size),
                            ..Default::default()
                        },
                        cx,
                    )
                })),
            );
        }
        let font_size_btn = select(
            "ui-font-size",
            ThemeMenu::FontSize,
            div()
                .child(SharedString::from(format!("{}px", a.ui_font_size)))
                .into_any_element(),
            cx,
        );

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
        let ai_language = a.ai_language;
        let mut ai_language_menu = popover(p)
            .absolute()
            .top(px(36.0))
            .right(px(0.0))
            .w(px(176.0));
        for language in [UiLanguage::Chinese, UiLanguage::English] {
            ai_language_menu = ai_language_menu.child(
                menu_item(
                    SharedString::from(format!("ai-language-{language:?}")),
                    ai_language == language,
                    hover,
                )
                .child(language_label(language))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        s.theme_menu = None;
                    }
                    this.patch_settings(
                        AppSettingsPatch {
                            ai_language: Some(language),
                            ..Default::default()
                        },
                        cx,
                    )
                })),
            );
        }
        let ai_language_btn = select(
            "ai-language",
            ThemeMenu::AiLanguage,
            div().child(language_label(ai_language)).into_any_element(),
            cx,
        );
        let heading = |label: &'static str| {
            div()
                .px(px(4.0))
                .text_size(px(TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .child(label)
        };
        let group = |label: &'static str, body: Div| {
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(heading(label))
                .child(body)
        };
        let float_when = |open: bool, button: AnyElement, menu: Div| {
            div()
                .relative()
                .child(button)
                .when(open, |d| d.child(ui::float(menu)))
        };
        let menu = s.theme_menu;

        let language = card(p)
            .child(setting_row(
                trs!(english, "settings.interface_language"),
                trs!(english, "settings.interface_language_desc"),
                false,
                p,
                float_when(
                    menu == Some(ThemeMenu::Language),
                    language_btn.into_any_element(),
                    language_menu,
                ),
            ))
            .child(setting_row(
                trs!(english, "settings.ai_language"),
                trs!(english, "settings.ai_language_desc"),
                true,
                p,
                float_when(
                    menu == Some(ThemeMenu::AiLanguage),
                    ai_language_btn.into_any_element(),
                    ai_language_menu,
                ),
            ));

        let appearance = card(p)
            .child(setting_row(
                trs!(english, "settings.theme_mode"),
                trs!(english, "settings.follow_the_macos_appearance_when"),
                false,
                p,
                float_when(
                    menu == Some(ThemeMenu::Mode),
                    mode_btn.into_any_element(),
                    mode_menu,
                ),
            ))
            .child(setting_row(
                trs!(english, "settings.light_theme"),
                trs!(english, "settings.theme_used_in_light_mode"),
                true,
                p,
                float_when(
                    menu == Some(ThemeMenu::Light),
                    light_btn.into_any_element(),
                    light_menu,
                ),
            ))
            .child(setting_row(
                trs!(english, "settings.dark_theme"),
                trs!(english, "settings.theme_used_in_dark_mode"),
                true,
                p,
                float_when(
                    menu == Some(ThemeMenu::Dark),
                    dark_btn.into_any_element(),
                    dark_menu,
                ),
            ))
            .child(setting_row(
                trs!(english, "settings.ui_font_size"),
                "",
                true,
                p,
                float_when(
                    menu == Some(ThemeMenu::FontSize),
                    font_size_btn.into_any_element(),
                    font_size_menu,
                ),
            ))
            // Offered only where there is a blur to show, as Electron's `HAS_VIBRANCY`.
            .when(cfg!(target_os = "macos"), |d| {
                d.child(self.settings_switch_row(
                    "glass",
                    trs!(english, "settings.glass_effect"),
                    trs!(english, "settings.make_the_window_background_translucent"),
                    glass,
                    |v| AppSettingsPatch {
                        glass: Some(v),
                        ..Default::default()
                    },
                    cx,
                ))
            });

        let runtime = card(p)
            .child(
                self.settings_switch_row(
                    "keep-awake",
                    trs!(english, "settings.keep_awake"),
                    trs!(english, "settings.prevent_macos_from_sleeping_during"),
                    keep_awake,
                    |v| AppSettingsPatch {
                        keep_awake: Some(v),
                        ..Default::default()
                    },
                    cx,
                )
                .border_t_0(),
            )
            .child(self.settings_switch_row(
                "notifications",
                trs!(english, "settings.system_notifications"),
                trs!(english, "settings.system_notifications_desc"),
                a.notifications,
                |v| AppSettingsPatch {
                    notifications: Some(v),
                    ..Default::default()
                },
                cx,
            ));

        let chat = card(p)
            .child(
                self.settings_switch_row(
                    "reply-suggestions",
                    trs!(english, "settings.reply_suggestions"),
                    trs!(english, "settings.suggest_what_you_may_say"),
                    reply_suggestions,
                    |v| AppSettingsPatch {
                        reply_suggestions: Some(v),
                        ..Default::default()
                    },
                    cx,
                )
                .border_t_0(),
            )
            .child(self.settings_switch_row(
                "code-mode",
                trs!(english, "settings.code_mode"),
                trs!(english, "settings.let_the_model_orchestrate_existing"),
                code_mode_enabled,
                |v| AppSettingsPatch {
                    code_mode_enabled: Some(v),
                    ..Default::default()
                },
                cx,
            ))
            .child(self.settings_switch_row(
                "tool-search",
                trs!(english, "settings.tool_search"),
                trs!(english, "settings.tool_search_desc"),
                a.tool_search_enabled,
                |v| AppSettingsPatch {
                    tool_search_enabled: Some(v),
                    ..Default::default()
                },
                cx,
            ))
            .child(self.settings_switch_row(
                "collapse-thinking",
                trs!(english, "settings.collapse_thinking"),
                trs!(english, "settings.collapse_thinking_desc"),
                a.collapse_thinking,
                |v| AppSettingsPatch {
                    collapse_thinking: Some(v),
                    ..Default::default()
                },
                cx,
            ))
            .child(self.settings_switch_row(
                "auto-compaction",
                trs!(english, "settings.auto_compact_context"),
                trs!(english, "settings.organize_context_near_its_limit"),
                auto_compaction_enabled,
                |v| AppSettingsPatch {
                    auto_compaction_enabled: Some(v),
                    ..Default::default()
                },
                cx,
            ))
            .child(self.settings_switch_row(
                "auto-review-approvals",
                trs!(english, "settings.auto_review_approvals"),
                trs!(english, "settings.auto_review_approvals_hint"),
                auto_review_approvals,
                |v| AppSettingsPatch {
                    auto_review_approvals: Some(v),
                    ..Default::default()
                },
                cx,
            ));

        div()
            .flex()
            .flex_col()
            .gap(px(24.0))
            .child(group(trs!(english, "settings.language_group"), language))
            .child(group(trs!(english, "settings.appearance"), appearance))
            .child(group(trs!(english, "settings.runtime_group"), runtime))
            .child(group(trs!(english, "settings.chat_group"), chat))
    }

    /// A switch row of 偏好设置; every one after the first in its card draws the divider.
    #[allow(clippy::too_many_arguments)]
    fn settings_switch_row(
        &self,
        id: &'static str,
        title: &str,
        description: &str,
        value: bool,
        patch: fn(bool) -> AppSettingsPatch,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = &self.palette;
        setting_row(
            title,
            description,
            true,
            p,
            switch(SharedString::from(id), value, p).on_click(
                cx.listener(move |this, _, _, cx| this.patch_settings(patch(!value), cx)),
            ),
        )
    }

    /// 归档对话: restore one to the sidebar, or delete it for good (after asking).
    fn archived_pane(&self, s: &SettingsState, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let days = self.app_settings.auto_archive_after_days;
        let days_label = |d: Option<u32>| match d {
            None => trs!(english, "settings.auto_archive_never").to_string(),
            Some(n) if english => format!("{n} days"),
            Some(n) => format!("{n} 天"),
        };
        let hover = p.c(Token::Accent);
        let mut menu = popover(p)
            .absolute()
            .top(px(34.0))
            .right(px(0.0))
            .w(px(176.0));
        for option in [
            None,
            Some(7),
            Some(14),
            Some(30),
            Some(90),
            Some(180),
            Some(365),
        ] {
            menu = menu.child(
                menu_item(
                    SharedString::from(format!("auto-archive-{option:?}")),
                    days == option,
                    hover,
                )
                .child(SharedString::from(days_label(option)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        s.theme_menu = None;
                    }
                    this.patch_settings(
                        AppSettingsPatch {
                            auto_archive_after_days: Some(option),
                            ..Default::default()
                        },
                        cx,
                    )
                })),
            );
        }
        let button = outline_button("auto-archive", p)
            .w(px(176.0))
            .h(px(30.0))
            .justify_between()
            .rounded(px(8.0))
            .font_weight(FontWeight::NORMAL)
            .text_size(px(TEXT_SM))
            .child(SharedString::from(days_label(days)))
            .child(icon("unfold-more", 14.0, p.c(Token::MutedForeground)))
            .on_click(cx.listener(|this, _, _, cx| {
                if let Some(s) = &mut this.settings {
                    s.theme_menu = if s.theme_menu == Some(ThemeMenu::AutoArchive) {
                        None
                    } else {
                        Some(ThemeMenu::AutoArchive)
                    };
                }
                cx.notify();
            }));
        let mut col = div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(
                div()
                    .pl(px(4.0))
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(trs!(english, "settings.archiving_hides_a_chat_from")),
            )
            .child(
                card(p).child(setting_row(
                    trs!(english, "settings.auto_archive"),
                    trs!(english, "settings.auto_archive_desc"),
                    false,
                    p,
                    div()
                        .relative()
                        .child(button)
                        .when(s.theme_menu == Some(ThemeMenu::AutoArchive), |d| {
                            d.child(ui::float(menu))
                        }),
                )),
            );
        let list = match &s.archived {
            None => card(p).child(
                div()
                    .px(px(16.0))
                    .py(px(20.0))
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(trs!(english, "settings.loading")),
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
                            .mb(px(8.0))
                            .size(px(32.0))
                            .rounded(px(8.0))
                            .bg(p.c(Token::Muted))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("archive04", 16.0, p.c(Token::Foreground))),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .font_weight(FontWeight::MEDIUM)
                            .child(trs!(english, "settings.no_archived_chats")),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(trs!(english, "settings.hover_a_chat_in_the")),
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
                        .unwrap_or_else(|| trs!(english, "settings.no_project").to_string());
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
                                            text::untitled(self.app_settings.language)
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
                                    .child(trs!(english, "settings.restore"))
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
                                    .child(trs!(english, "settings.delete"))
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
        let mut menu = popover(p)
            .absolute()
            .top(px(52.0))
            .right(px(16.0))
            .w(px(300.0));
        let english = self.app_settings.language == UiLanguage::English;
        // Heights are fixed so the sibling flyout can align with the last row. A child of this
        // card is clipped to it, which is why the flyout is not one.
        menu = menu.child(
            menu_label(trs!(english, "settings.model"), p)
                .h(px(24.0))
                .line_height(px(16.0)),
        );
        if self.models.is_empty() {
            menu = menu.child(
                div()
                    .h(px(28.0))
                    .px(px(8.0))
                    .py(px(6.0))
                    .muted(p)
                    .child(text::no_model_hint(self.app_settings.language)),
            );
        }
        // One row per provider, its models in a flyout beside this card — the same fold the
        // composer's chip makes, and what keeps a dozen models off one settings popover.
        let current = self.defaults.model.clone();
        let open_provider = self
            .settings
            .as_ref()
            .and_then(|s| s.default_provider_menu.clone());
        for group in provider_groups(&self.models) {
            let id = group.id.to_string();
            let clicked_id = id.clone();
            let holds_current = group_holds_current(&group, current.as_deref());
            let open = open_provider.as_deref() == Some(group.id);
            menu = menu.child(
                provider_row(
                    SharedString::from(format!("dm-{id}")),
                    group.id,
                    group.name,
                    holds_current,
                    open,
                    p,
                )
                .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    if !*hovered {
                        this.close_default_submenu_after_hover(cx);
                        return;
                    }
                    let Some(s) = &mut this.settings else {
                        return;
                    };
                    this.hover_submenus.entered();
                    // One flyout at a time: the effort list and a provider's models cannot both
                    // hang off this card, or they draw on top of each other.
                    if s.default_thinking_menu
                        || s.default_provider_menu.as_deref() != Some(id.as_str())
                    {
                        s.default_thinking_menu = false;
                        s.default_provider_menu = Some(id.clone());
                        cx.notify();
                    }
                }))
                .on_click(cx.listener(move |this, _, _, cx| {
                    let Some(s) = &mut this.settings else {
                        return;
                    };
                    this.hover_submenus.entered();
                    s.default_thinking_menu = false;
                    s.default_provider_menu =
                        if s.default_provider_menu.as_deref() == Some(clicked_id.as_str()) {
                            None
                        } else {
                            Some(clicked_id.clone())
                        };
                    cx.notify();
                })),
            );
        }
        menu = menu.child(div().my(px(4.0)).h(px(1.0)).bg(p.c(Token::Border)));
        menu.child(self.default_thinking_row(cx))
    }

    /// Electron's `ModelThinkingSelect`: the effort is one row; the levels are a sibling float.
    fn default_thinking_row(&self, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let english = self.app_settings.language == UiLanguage::English;
        let open = self
            .settings
            .as_ref()
            .is_some_and(|s| s.default_thinking_menu);
        let effective = self
            .defaults
            .model
            .as_ref()
            .and_then(|l| self.models.iter().find(|m| &m.label == l))
            .map_or(self.defaults.thinking, |m| {
                m.model.effective_thinking(self.defaults.thinking)
            });
        let current = effective
            .map(|level| thinking_label_in(level, english))
            .unwrap_or(trs!(english, "settings.follow_model_default"));
        div().w_full().child(
            menu_item("default-thinking".into(), open, hover)
                .h(px(32.0))
                .w_full()
                .justify_between()
                .child(trs!(english, "settings.thinking_effort"))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .flex_none()
                        .text_size(px(TEXT_XS))
                        .text_color(p.c(Token::MutedForeground))
                        .child(current)
                        .child(icon("arrow-right01", 12.0, p.c(Token::MutedForeground))),
                )
                .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                    if !*hovered {
                        this.close_default_submenu_after_hover(cx);
                        return;
                    }
                    if let Some(s) = &mut this.settings {
                        // The provider flyout and effort flyout are sibling overlays. Moving
                        // onto this row must hand ownership to the effort flyout immediately;
                        // otherwise the previous provider's models remain visible beside it.
                        this.hover_submenus.entered();
                        if !s.default_thinking_menu || s.default_provider_menu.is_some() {
                            s.default_provider_menu = None;
                            s.default_thinking_menu = true;
                            cx.notify();
                        }
                    }
                }))
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(s) = &mut this.settings {
                        this.hover_submenus.entered();
                        s.default_provider_menu = None;
                        s.default_thinking_menu = !s.default_thinking_menu;
                    }
                    cx.notify();
                })),
        )
    }

    /// Levels beside the session-model menu. A sibling of that card, not a child: the card clips
    /// anything that sticks out, and a clipped glass fill lets the page show through.
    fn thinking_flyout(&self, window: &Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
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
        let flyout_w = if english { 208.0 } else { 168.0 };
        // Menu is top 52 / right 16 / 300 wide. The last row starts after the locked heights.
        let row_top = 4.0
            + 24.0
            + if self.models.is_empty() {
                28.0
            } else {
                provider_groups(&self.models).len() as f32 * 32.0
            }
            + 9.0;
        let mut flyout = popover(p)
            .id("default-thinking-submenu")
            .absolute()
            .top(px(52.0 + row_top - 4.0))
            .w(px(flyout_w));
        // Overlap the menu by 12px so the pointer can cross without hitting the catcher.
        flyout = if self.thinking_flyout_opens_left(window, flyout_w) {
            flyout.right(px(16.0 + 300.0 - 12.0))
        } else {
            flyout.right(px(16.0 - (flyout_w - 12.0)))
        };
        flyout = flyout.child(self.thinking_choice(
            None,
            trs!(english, "settings.follow_model_default"),
            self.defaults.thinking.is_none(),
            cx,
        ));
        for level in LEVELS {
            if allowed.as_ref().is_some_and(|v| !v.contains(&level)) {
                continue;
            }
            flyout = flyout.child(self.thinking_choice(
                Some(level),
                thinking_label_in(level, english),
                self.defaults.thinking.is_some() && effective == Some(level),
                cx,
            ));
        }
        flyout.on_hover(cx.listener(|this, hovered: &bool, _, cx| {
            if *hovered {
                this.hover_submenus.entered();
            } else {
                this.close_default_submenu_after_hover(cx);
            }
        }))
    }

    /// The session-model menu sits on the right of the settings column. Open the flyout right
    /// when the window has room, otherwise left.
    fn thinking_flyout_opens_left(&self, window: &Window, flyout_w: f32) -> bool {
        let width = f32::from(window.viewport_size().width);
        let nav = self.settings_nav_width(window);
        let content = (width - nav).max(0.0);
        let body = content.min(768.0);
        let body_right = nav + (content - body) / 2.0 + body;
        let menu_right = body_right - 32.0;
        menu_right + flyout_w + 12.0 > width
    }

    /// The models of the provider whose row is open, standing beside the 默认模型 card. Its own
    /// float for the same reason the effort list is one — the card clips what sticks out — and it
    /// hangs off the row it belongs to: a list that always started at the card's foot would name a
    /// different provider each time the roster grew.
    fn default_provider_flyout(&self, window: &Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let Some(open) = self
            .settings
            .as_ref()
            .and_then(|s| s.default_provider_menu.clone())
        else {
            return div().id("default-model-submenu-empty");
        };
        let flyout_w = if english { 208.0 } else { 168.0 };
        // Rows start below the card's padding and its 模型 label, and are 32 tall by design.
        let row = provider_groups(&self.models)
            .iter()
            .position(|group| group.id == open)
            .unwrap_or(0) as f32;
        let mut flyout = popover(p)
            .id("default-model-submenu")
            .absolute()
            .top(px(52.0 + 4.0 + 24.0 + row * 32.0))
            .w(px(flyout_w))
            .max_h(px(320.0))
            .overflow_y_scroll();
        flyout = if self.thinking_flyout_opens_left(window, flyout_w) {
            flyout.right(px(16.0 + 300.0 - 12.0))
        } else {
            flyout.right(px(16.0 - (flyout_w - 12.0)))
        };
        for m in self.models.iter().filter(|m| m.provider_id == open) {
            let label = m.label.clone();
            let current = self.defaults.model.as_deref() == Some(label.as_str());
            flyout = flyout.child(
                model_row(
                    SharedString::from(format!("dmp-{label}")),
                    model_display_name(m),
                    current,
                    p,
                )
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
        flyout.on_hover(cx.listener(|this, hovered: &bool, _, cx| {
            if *hovered {
                this.hover_submenus.entered();
            } else {
                this.close_default_submenu_after_hover(cx);
            }
        }))
    }

    fn thinking_choice(
        &self,
        level: Option<ThinkingLevel>,
        label: &'static str,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let id = match level {
            None => "default-thinking-inherit".to_string(),
            Some(level) => format!("dl-{level:?}"),
        };
        menu_item(SharedString::from(id), false, hover)
            .w_full()
            .justify_between()
            .child(label)
            .when(selected, |d| {
                d.child(icon("tick02", 14.0, p.c(Token::PopoverForeground)))
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                let model = this.defaults.model.clone();
                this.set_default(
                    ModelDefaults {
                        model,
                        thinking: level,
                    },
                    cx,
                );
            }))
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
                    .text_size(px(TEXT_SM))
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
                        .child(trs!(english, "settings.not_connected")),
                )
            })
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(SharedString::from(format!(
                        "{} {}",
                        provider.models.len(),
                        trs!(english, "settings.models")
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
        let field = |key: &'static str| {
            div()
                .text_size(px(TEXT_XS))
                .muted(p)
                .mb(px(6.0))
                .child(trs!(english, key))
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
                        d.child(
                            div()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(trs!(english, "settings.edited")),
                        )
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
                    trs!(english, "settings.no_models_yet_click_to")
                } else {
                    trs!(english, "settings.connect_to_choose_models")
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
                div().child(field("settings.base_url")).child(
                    div()
                        .flex()
                        .gap(px(6.0))
                        .child(div().flex_1().child(ui::input(&edit.base_url)))
                        .child(
                            outline_button(SharedString::from(format!("save-url-{id}")), p)
                                .child(trs!(english, "settings.save"))
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
                div().child(field("settings.api_format")).child(
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
                div().child(field("settings.api_key")).child(
                    div()
                        .flex()
                        .gap(px(6.0))
                        .child(div().flex_1().child(ui::input(&edit.key).mask_toggle()))
                        .child(
                            outline_button(SharedString::from(format!("save-key-{id}")), p)
                                .child(trs!(english, "settings.save"))
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
                            .child(trs!(english, "settings.model_list"))
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
        if let Some(dialog) = self.computer_install_dialog(cx) {
            return Some(dialog);
        }
        let s = self.settings.as_ref()?;
        if s.model_edit.is_some() {
            return self.model_detail_dialog(cx);
        }
        // The MCP server form and the subagent role editor are Electron dialogs: drawn over the
        // pane, closed by the backdrop as by their own Cancel.
        if s.section == Section::Mcp && self.mcp_form_open() {
            let body = div().id("mcp-form-dialog").child(self.mcp_form(cx));
            return Some(modal(div().child(body), &self.palette, cx, |this| {
                this.close_mcp_form()
            }));
        }
        if s.section == Section::Subagents
            && let Some(editor) = self.role_editor_dialog(cx)
        {
            let body = div().id("role-editor-dialog").child(editor);
            return Some(modal(div().child(body), &self.palette, cx, |this| {
                this.close_role_editor()
            }));
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
                    trs!(english, "settings.delete_this_chat"),
                    &tr!(english, "settings.title_and_all_of_its", title = title),
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
                    trs!(english, "settings.delete"),
                    move |this, _, cx| {
                        if let Some(s) = &mut this.settings {
                            s.confirm_delete = None;
                        }
                        this.delete_thread(target.clone(), cx);
                    },
                    false,
                    self.english(),
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
                    &tr!(english, "settings.manage_models_name", name = name),
                    trs!(english, "settings.select_the_models_to_use"),
                    &self.palette,
                ))
                .child(
                    div()
                        .px(px(20.0))
                        .pb(px(16.0))
                        .child(
                            div()
                                .text_size(px(TEXT_XS))
                                .muted(&self.palette)
                                .child(trs!(english, "settings.manual_model_id_desc")),
                        )
                        .child(ui::input(&am.manual_model))
                        .child(self.picker(
                            &am.picker,
                            |s| s.add_models.as_mut().map(|a| &mut a.picker),
                            cx,
                        )),
                )
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
                        trs!(english, "settings.saving")
                    } else {
                        trs!(english, "settings.confirm")
                    },
                    |this, _, cx| this.finish_add_models(cx),
                    am.busy,
                    self.english(),
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
            let add_label = if n > 0 {
                tr!(english, "settings.add_n_models", n = n)
            } else {
                trs!(english, "settings.add_manual_model").to_string()
            };
            return dialog_card(p, 672.0)
                .child(dialog_head(
                    trs!(english, "settings.choose_models"),
                    &match &picker.models {
                        Some(list) => {
                            tr!(
                                english,
                                "settings.fetched_arg1_models_select_the",
                                arg1 = list.len()
                            )
                        }
                        None => trs!(english, "settings.fetching_model_list").to_string(),
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
                        .child(
                            div()
                                .child(
                                    div()
                                        .text_size(px(TEXT_XS))
                                        .muted(p)
                                        .child(trs!(english, "settings.manual_model_id_desc")),
                                )
                                .child(ui::input(&a.manual_model)),
                        )
                        .child(self.picker(
                            picker,
                            |s| s.add.as_mut().and_then(|a| a.picker.as_mut()),
                            cx,
                        ))
                        .when_some(a.error.clone(), |d, e| {
                            d.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .text_size(px(TEXT_XS))
                                    .text_color(p.c(Token::Destructive))
                                    .child(SharedString::from(e))
                                    .child(
                                        outline_button("retry-provider-fetch", p)
                                            .h(px(26.0))
                                            .child(trs!(english, "settings.retry"))
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.retry_provider_fetch(cx)
                                            })),
                                    ),
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
                    &add_label,
                    |this, _, cx| this.finish_add_provider(cx),
                    a.busy,
                    self.english(),
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
                        .child(label(trs!(english, "settings.name")))
                        .child(ui::input(&a.name)),
                )
                .child(div().child(label("Base URL")).child(ui::input(&a.base_url)))
                .child(
                    div()
                        .child(label(trs!(english, "settings.api_format")))
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
                    .child(label(trs!(english, "settings.api_key")))
                    .child(ui::input(&a.key).mask_toggle()),
            )
            .child(
                div()
                    .child(label(trs!(english, "settings.manual_model_id")))
                    .child(ui::input(&a.manual_model))
                    .child(
                        div()
                            .mt(px(4.0))
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(trs!(english, "settings.manual_model_id_desc")),
                    ),
            )
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(SharedString::from(protocol_example(
                        a.protocol,
                        self.app_settings.language,
                    ))),
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
                trs!(english, "settings.add_provider"),
                trs!(english, "settings.enter_a_name_url_and"),
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
                    trs!(english, "settings.fetching")
                } else {
                    trs!(english, "settings.confirm")
                },
                |this, window, cx| this.confirm_add_provider(window, cx),
                a.busy,
                self.english(),
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
                        .child(trs!(english, "settings.fetching_model_list")),
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
                            || trs!(english, "settings.no_models").to_string(),
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
                    .child(div().flex_1().child(ui::input(&picker.search).prefix(icon(
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
                        .line_height(px(20.0))
                        .font_weight(FontWeight::MEDIUM)
                        .child(SharedString::from(title.to_string())),
                )
                .when(!description.is_empty(), |d| {
                    d.child(
                        div()
                            .mt(px(2.0))
                            .text_size(px(TEXT_XS))
                            .line_height(px(16.0))
                            .muted(p)
                            .child(SharedString::from(description.to_string())),
                    )
                }),
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
    // `rounded-xl`.
    div()
        .rounded(px(12.0))
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

/// `.overlay-surface` shared by menus, popovers and dialogs.
fn overlay_surface(d: Div, radius: f32, p: &crate::theme::Palette) -> Div {
    crate::ui::overlay_surface(d, radius, p)
}

pub(super) fn popover(p: &crate::theme::Palette) -> Div {
    overlay_surface(div().p(px(4.0)), 10.0, p)
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
    overlay_surface(div().w(px(width)).max_w(relative(0.92)), 10.0, p)
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
    english: bool,
) -> Div {
    dialog_foot_with_cancel(
        p,
        cx,
        cancel,
        trs!(english, "settings.cancel"),
        confirm_label,
        confirm,
        disabled,
    )
}

pub(super) fn dialog_foot_with_cancel(
    p: &crate::theme::Palette,
    cx: &mut Context<Workspace>,
    cancel: impl Fn(&mut Workspace, &mut Context<Workspace>) + 'static,
    cancel_label: &str,
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
        .when(p.glass(), |d| d.rounded_b(gpui_kit::px(14.0)))
        .when(!p.glass(), |d| d.rounded_b(px(10.0)))
        .child(
            outline_button("dialog-cancel", p)
                .child(SharedString::from(cancel_label.to_string()))
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

/// An import source's product name, as the user knows it.
fn source_name(id: &str) -> &'static str {
    match id {
        "pi" => "pi coding agent",
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "opencode",
        "zcode" => "zcode",
        _ => "Agent",
    }
}

/// `MM/DD` in local time, for an import source's latest session.
fn month_day(at_ms: i64) -> Option<String> {
    if at_ms <= 0 {
        return None;
    }
    // SAFETY: `localtime_r` writes only into the `tm` it is given.
    unsafe {
        let secs = (at_ms / 1000) as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            return None;
        }
        Some(format!("{:02}/{:02}", tm.tm_mon + 1, tm.tm_mday))
    }
}
