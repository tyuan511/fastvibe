//! Canned data matching the Electron preview (`src/renderer/src/mock/preview-data.ts`), so the
//! two apps can be screenshotted on the same conversation and compared.

use fv_protocol::types::*;
use serde_json::json;

use crate::view_model::ThreadView;

pub struct Fixture {
    pub threads: Vec<Thread>,
    /// A one-line notice above the composer (the result of a retry's file rewind).
    pub rewound_notice: Option<String>,
    /// 回复推荐's standing guess, drawn as the composer's placeholder.
    pub suggestion: Option<String>,
    /// A draft already in the composer.
    pub draft: Option<String>,
    /// Open the terminal tab, for the capture fixture.
    pub terminal: bool,
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
        source: None,
        created_at: updated,
        updated_at: updated,
        archived: false,
        unread: false,
        pinned: false,
        worktree: None,
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
        stats: SessionStats {
            tokens: TokenCounts {
                input: 48_210,
                output: 3_180,
                cache_read: 12_400,
                cache_write: 2_048,
            },
            turn: Some(TokenCounts {
                input: 12_940,
                output: 620,
                cache_read: 34_100,
                cache_write: 512,
            }),
            last_request: Some(RequestUsage {
                output_tokens: 320,
                duration_ms: Some(4000),
            }),
            steps: 4,
            cost: None,
        },
        thread: threads[0].clone(),
        token_usage: Some(TokenUsage {
            used: 24_400,
            window: 128_000,
        }),
        turns,
        seq: 0,
        running: false,
        queue: QueueState::default(),
        goal: None,
        suggestion: None,
    };
    Fixture {
        threads,
        rewound_notice: None,
        suggestion: None,
        draft: None,
        terminal: false,
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

/// A reply in flight with prompts queued behind it: what the tray above the composer looks like,
/// including the paused state a failed turn leaves behind.
pub fn queued() -> Fixture {
    let mut fixture = theme_conversation();
    if let Some(view) = &mut fixture.view {
        view.running = true;
        view.active_turn = Some("t-live".into());
        view.queue = QueueState {
            items: vec![
                QueueItem {
                    id: "q1".into(),
                    text: "把刚才那两个测试也补上".into(),
                    at: 1,
                },
                QueueItem {
                    id: "q2".into(),
                    text: "顺手更新一下 docs/native-rewrite.md 的进度一节".into(),
                    at: 2,
                },
            ],
            pause: None,
        };
    }
    fixture
}

/// The same queue after a turn failed: nothing drains until the user says so.
pub fn queued_paused() -> Fixture {
    let mut fixture = queued();
    if let Some(view) = &mut fixture.view {
        view.running = false;
        view.queue.pause = Some(QueuePauseReason::Failed);
    }
    fixture
}

/// The right pane open on a real directory, so the tree and the preview can be looked at without
/// a running server: the fixture points it at this checkout.
pub fn side_pane() -> Fixture {
    let mut fixture = theme_conversation();
    if let Some(view) = &mut fixture.view {
        view.thread.cwd = Some("/Users/yuantang/code/fastvibe".into());
    }
    fixture
}

/// The terminal tab, running a real shell in this checkout.
pub fn terminal() -> Fixture {
    let mut fixture = theme_conversation();
    if let Some(view) = &mut fixture.view {
        view.thread.cwd = Some("/Users/yuantang/code/fastvibe".into());
    }
    fixture.terminal = true;
    fixture
}

/// A composer mid-`@`: the file menu open over a half-typed path.
pub fn mention() -> Fixture {
    let mut fixture = theme_conversation();
    if let Some(view) = &mut fixture.view {
        view.thread.cwd = Some("/Users/yuantang/code/fastvibe".into());
    }
    fixture.draft = Some("看一下 @native/crates/fv-gui/src/".into());
    fixture
}

/// An empty composer offering 回复推荐 as its placeholder.
pub fn suggestion() -> Fixture {
    let mut fixture = new_chat();
    fixture.suggestion = Some("把这两个测试也补上，再顺手跑一遍 pnpm test".into());
    fixture
}

/// The notice a retry leaves behind when it put the workspace back.
pub fn rewound_notice() -> Fixture {
    let mut fixture = theme_conversation();
    fixture.rewound_notice = Some("已退回工作区：还原 1 个文件，删除 1 个".into());
    fixture
}

/// The queue after the user pressed 停止: the same pause, but its own sentence.
pub fn queued_stopped() -> Fixture {
    let mut fixture = queued_paused();
    if let Some(view) = &mut fixture.view {
        view.queue.pause = Some(QueuePauseReason::Stopped);
    }
    fixture
}

/// The conversation with a command waiting for the user's say-so.
pub fn approval() -> Fixture {
    let mut f = theme_conversation();
    if let Some(view) = &mut f.view {
        view.approvals.push((
            fv_protocol::RequestId::String("approval-1".into()),
            ApprovalRequestParams {
                thread_id: view.thread.id.clone(),
                turn_id: "turn-2".into(),
                call_id: "t7".into(),
                kind: ApprovalKind::Command {
                    command: "pnpm install --frozen-lockfile".into(),
                    cwd: Some("/Users/dev/FastVibe/fastvibe".into()),
                },
                reason: Some("安装依赖需要访问网络，沙箱里不允许。要在沙箱外运行吗？".into()),
            },
        ));
    }
    f
}

/// A reply that uses every kind of markdown block, for checking how they are drawn.
pub fn markdown() -> Fixture {
    let mut f = theme_conversation();
    let rich = "## 改动概览\n\n已完成，改动集中在 **设置页**，详见 [文档](https://example.com/docs) 和 `settings.json`：\n\n- 「主题模式」下拉支持 跟随系统 / 亮色 / 暗色\n- `useThemeSync` 监听 `prefers-color-scheme`\n  - 嵌套的一层\n- 亮色与暗色各自记忆\n\n1. 先改 `themes.ts`\n2. 再改设置页\n3. 最后跑 `pnpm typecheck`\n\n### 示例\n\n```ts\nexport function resolveTheme(mode: ThemeMode, dark: boolean) {\n  return mode === \"system\" ? (dark ? \"dark\" : \"light\") : mode;\n}\n```\n\n> 注意：跟随系统时会先固定为此刻生效的主题。\n\n| 模式 | 含义 | 默认 |\n| --- | --- | --- |\n| light | 亮色 | 否 |\n| system | 跟随系统 | 是 |\n\n---\n\n需要的话，我可以再把它接进命令面板。";
    if let Some(view) = &mut f.view {
        view.turns.truncate(1);
        for turn in &mut view.turns {
            // Only the answer: the process above it would fold away anyway.
            turn.items.retain(|i| {
                matches!(i, Item::UserMessage { .. })
                    || matches!(i, Item::AgentMessage { id, .. } if id == "a3")
            });
            for item in &mut turn.items {
                if let Item::AgentMessage { id, text } = item
                    && id == "a3"
                {
                    *text = rich.to_string();
                }
            }
        }
    }
    f
}

/// The first turn alone, so its process is what is on screen.
pub fn process() -> Fixture {
    let mut f = theme_conversation();
    if let Some(view) = &mut f.view {
        view.turns.truncate(1);
    }
    f
}

/// The conversation with a question put to the user.
pub fn question() -> Fixture {
    let mut f = theme_conversation();
    if let Some(view) = &mut f.view {
        let opt = |l: &str, d: &str| QuestionOption {
            label: l.into(),
            description: d.into(),
        };
        view.questions.push((
            fv_protocol::RequestId::String("question-1".into()),
            UserInputRequest {
                thread_id: view.thread.id.clone(),
                turn_id: "turn-2".into(),
                call_id: "q1".into(),
                questions: vec![Question {
                    id: "scope".into(),
                    header: "范围".into(),
                    question: "要改多大范围？".into(),
                    options: vec![
                        opt("只改这个文件", "改动最小"),
                        opt("整个模块", "更大的重构"),
                        opt("先出方案", "不动代码，先讨论"),
                    ],
                    is_other: true,
                }],
            },
        ));
    }
    f
}

/// The empty page of a new conversation, with the same sidebar.
pub fn new_chat() -> Fixture {
    let mut f = theme_conversation();
    f.view = None;
    f.draft_project = Some(FASTVIBE.into());
    f
}
