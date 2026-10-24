//! Canned data matching the Electron preview (`src/renderer/src/mock/preview-data.ts`), so the
//! two apps can be screenshotted on the same conversation and compared.

use fv_protocol::types::*;
use serde_json::json;

use crate::view_model::ThreadView;

pub struct Fixture {
    pub threads: Vec<Thread>,
    pub models: Vec<ModelEntry>,
    pub defaults: ModelDefaults,
    pub view: Option<ThreadView>,
    pub draft_project: Option<String>,
}

const FASTVIBE: &str = "/Users/dev/FastVibe/fastvibe";
const PAPER: &str = "/Users/dev/FastVibe/paper-trail";

fn thread(id: &str, title: &str, project: Option<&str>, updated: i64) -> Thread {
    Thread {
        id: id.into(),
        title: title.into(),
        cwd: project.map(Into::into),
        project: project.map(Into::into),
        created_at: updated,
        updated_at: updated,
        archived: false,
        unread: false,
        model: None,
        thinking: None,
    }
}

/// A turn that started, finished its work and ended at these times.
fn timed(mut turn: Turn, started: i64, process_ended: i64, completed: i64) -> Turn {
    turn.started_at = Some(started);
    turn.process_ended_at = Some(process_ended);
    turn.completed_at = Some(completed);
    turn
}

fn user(id: &str, text: &str) -> Item {
    Item::UserMessage {
        id: id.into(),
        text: text.into(),
    }
}

fn say(id: &str, text: &str) -> Item {
    Item::AgentMessage {
        id: id.into(),
        text: text.into(),
    }
}

fn think(id: &str, text: &str) -> Item {
    Item::Reasoning {
        id: id.into(),
        text: text.into(),
    }
}

fn run(id: &str, cmd: &str, output: &str, failed: bool) -> Item {
    Item::ToolCall {
        id: id.into(),
        name: "exec_command".into(),
        arguments: json!({ "cmd": cmd }),
        output: Some(output.into()),
        is_error: failed,
    }
}

fn patch(id: &str, input: &str) -> Item {
    Item::ToolCall {
        id: id.into(),
        name: "apply_patch".into(),
        arguments: json!({ "input": input }),
        output: Some("Success.".into()),
        is_error: false,
    }
}

/// `mock.html?lang=zh&theme=light`: the conversation 设置里的主题模式.
pub fn theme_conversation() -> Fixture {
    let now = 1_792_800_000_000_i64;
    let min = 60_000;
    let hour = 60 * min;
    let day = 24 * hour;
    let threads = vec![
        thread(
            "conv-theme",
            "设置里的主题模式",
            Some(FASTVIBE),
            now - 2 * min,
        ),
        thread(
            "conv-plugins",
            "梳理 pi 扩展的加载流程",
            Some(FASTVIBE),
            now - 5 * hour,
        ),
        thread(
            "conv-queue",
            "修复消息队列重复发送",
            Some(FASTVIBE),
            now - 2 * day,
        ),
        thread(
            "conv-cowork",
            "多智能体协作的入口设计",
            Some(FASTVIBE),
            now - 4 * day,
        ),
        thread(
            "conv-paper",
            "论文摘录的自动归档",
            Some(PAPER),
            now - 6 * day,
        ),
        thread("conv-readme", "写一篇介绍 README", None, now - 20 * hour),
        thread("conv-weekly", "整理这周的改动", None, now - 3 * day),
    ];
    let settings_patch = "*** Begin Patch\n*** Update File: src/renderer/src/components/settings/settings-dialog.tsx\n@@\n+        <SettingsRow label=\"主题模式\">\n+          <ThemeModeSelect />\n+        </SettingsRow>\n-        {/* TODO: theme mode */}\n*** End Patch\n";
    let shortcut_patch = "*** Begin Patch\n*** Update File: src/renderer/src/App.tsx\n@@\n+  useHotkeys(\"mod+j\", () => {\n+    const next = resolvedTheme === \"dark\" ? \"light\" : \"dark\";\n+    updateSettings({ themeMode: next });\n+  }, {\n+    enableOnFormTags: true,\n+    preventDefault: true,\n+  });\n+\n*** End Patch\n";
    let turns = vec![
        timed(
            Turn::new(
                "turn-1".into(),
                vec![
                    user(
                        "u1",
                        "帮我看看设置里的主题切换，再补一个「跟随系统」的选项。",
                    ),
                    think("r1", "先找到主题选择器，再看 themeMode 是怎么持久化的。"),
                    say("a1", "我先定位主题选择器，以及主题是怎么应用和持久化的。"),
                    run(
                        "t1",
                        "rg -n themeMode src/renderer/src",
                        "src/renderer/src/lib/themes.ts:42",
                        false,
                    ),
                    say(
                        "a2",
                        "现有的 `themeMode` 已经支持 `light | dark | system`，但「通用」页里只暴露了亮色 / 暗色两个主题，缺少切换模式的入口。我在「外观」分组补一个「主题模式」下拉。",
                    ),
                    patch("t2", settings_patch),
                    run("t3", "pnpm typecheck", "Process exited with code 0", false),
                    say(
                        "a3",
                        "已完成，改动集中在设置页：\n\n- 「主题模式」下拉支持 跟随系统 / 亮色 / 暗色，写入 `settings.json`。\n- `useThemeSync` 在跟随系统时监听 `prefers-color-scheme`，切换 macOS 外观即时生效。\n- 亮色与暗色主题各自独立记忆，切换模式不会丢失选择。\n\n需要的话，我可以再把它接进命令面板。",
                    ),
                ],
            ),
            now - 23 * min,
            now - 21 * min,
            now - 20 * min - 36_000,
        ),
        Turn::new(
            "turn-compact".into(),
            vec![Item::ContextCompaction { id: "c1".into() }],
        ),
        timed(
            Turn::new(
                "turn-2".into(),
                vec![
                    user("u2", "顺便加个 ⌘J 快捷键，快速在亮色和暗色之间切换。"),
                    say(
                        "a4",
                        "好的，我在应用层注册一个全局快捷键，并顺手跑一遍验证脚本。",
                    ),
                    patch("t4", shortcut_patch),
                    run(
                        "t5",
                        "pnpm verify",
                        "ERR_PNPM_NO_SCRIPT  Missing script: verify",
                        true,
                    ),
                    think("r2", "脚本没找到，换成直接构建一遍看看。"),
                    run("t6", "pnpm build", "Process exited with code 1", true),
                    say(
                        "a5",
                        "已注册：`⌘J` 会在亮色 / 暗色之间切换；当前若处于「跟随系统」，会先固定为此刻生效的主题再切换。输入框内按 `⌘J` 也不会被吞掉。",
                    ),
                ],
            ),
            now - 3 * min,
            now - 3 * min + 18_000,
            now - 2 * min - 24_000,
        ),
    ];
    let snapshot = ThreadResumeResponse {
        thread: threads[0].clone(),
        token_usage: None,
        turns,
        seq: 0,
        running: false,
    };
    Fixture {
        threads,
        models: vec![ModelEntry {
            provider_id: "deepseek".into(),
            provider_name: "DeepSeek".into(),
            model: serde_json::from_value(json!({ "id": "deepseek-v4-pro" })).expect("model"),
            label: "deepseek/deepseek-v4-pro".into(),
        }],
        defaults: ModelDefaults {
            model: Some("deepseek/deepseek-v4-pro".into()),
            thinking: Some(ThinkingLevel::High),
        },
        view: Some(ThreadView::from_snapshot(snapshot)),
        draft_project: None,
    }
}

/// The empty page of a new conversation, with the same sidebar.
pub fn new_chat() -> Fixture {
    let mut f = theme_conversation();
    f.view = None;
    f.draft_project = Some(FASTVIBE.into());
    f
}
