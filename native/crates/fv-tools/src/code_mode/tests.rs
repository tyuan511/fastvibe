use super::*;
use fv_agent::NestedTools;
struct Dispatch;
impl NestedTools for Dispatch {
    fn call(&self, ctx: ToolCtx, name: String, args: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            match ctx.registry.get(&name) {
                Some(t) if !t.orchestrates() => t.call(ctx, args).await,
                _ => ToolOutput::err("unavailable"),
            }
        })
    }
}
fn setup() -> (Arc<CodeMode>, ToolCtx) {
    let pool = Arc::new(CodeMode::default());
    let mut registry = ToolRegistry::new();
    pool.register(&mut registry);
    let mut ctx = ToolCtx::new(CancellationToken::new(), None);
    ctx.registry = Arc::new(registry);
    ctx.nested = Some(Arc::new(Dispatch));
    ctx.call_id = "outer".into();
    ctx.history_call_id = "outer".into();
    (pool, ctx)
}
async fn exec(ctx: &ToolCtx, code: &str, ms: u64) -> ToolOutput {
    ctx.registry
        .get("code_mode")
        .unwrap()
        .call(ctx.clone(), json!({"code":code,"yield_time_ms":ms}))
        .await
}
async fn wait(ctx: &ToolCtx, id: &str, terminate: bool) -> ToolOutput {
    ctx.registry
        .get("wait")
        .unwrap()
        .call(
            ctx.clone(),
            json!({"cell_id":id,"yield_time_ms":2000,"terminate":terminate}),
        )
        .await
}
fn id(out: &ToolOutput) -> String {
    out.content
        .strip_prefix("Script running with cell ID ")
        .unwrap()
        .split('.')
        .next()
        .unwrap()
        .to_string()
}
#[tokio::test]
async fn isolated_modules_keep_only_explicit_json_values_and_reject_host_io() {
    let (pool, ctx) = setup();
    let first=exec(&ctx,"const privateValue=42; store('answer',{value:privateValue}); text(await Promise.resolve(privateValue)); text([typeof process,typeof require,typeof fetch,typeof console,typeof tools.code_mode,typeof tools.wait]);",2000).await;
    assert!(!first.is_error, "{}", first.content);
    assert!(first.content.contains("42"));
    assert!(first.content.contains("undefined"));
    let next=exec(&ctx,"text(typeof privateValue); text(load('answer')); text(load('missing')); let rejected=false; try{await import('node:fs')}catch{rejected=true} text(rejected);",2000).await;
    assert!(!next.is_error, "{}", next.content);
    assert!(next.content.contains("\"value\":42"));
    assert!(next.content.ends_with("true"));
    pool.settle().await;
}
#[tokio::test]
async fn yielded_results_are_incremental_and_survive_other_completed_cells() {
    let (pool, ctx) = setup();
    let first=exec(&ctx,"text('first'); await yield_control(); await new Promise(r=>setTimeout(r,30)); text('second');",2000).await;
    let cell = id(&first);
    assert!(first.content.contains("first"));
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(!exec(&ctx, "text('different cell');", 2000).await.is_error);
    let last = wait(&ctx, &cell, false).await;
    assert!(!last.is_error, "{}", last.content);
    assert!(last.content.contains("second"));
    assert!(!last.content.contains("first"));
    assert!(wait(&ctx, &cell, false).await.is_error);
    pool.settle().await;
}
#[tokio::test]
async fn a_cpu_loop_yields_and_can_be_terminated_without_blocking_tokio() {
    let (pool, ctx) = setup();
    let start = std::time::Instant::now();
    let out = exec(&ctx, "while(true){}", 20).await;
    assert!(start.elapsed() < Duration::from_secs(1));
    let result = wait(&ctx, &id(&out), true).await;
    assert!(result.is_error, "{}", result.content);
    assert!(!pool.has_running());
    pool.settle().await;
}
#[tokio::test]
async fn module_end_discards_unawaited_timers_and_exit_cannot_be_caught_to_continue() {
    let (pool, ctx) = setup();
    let start = std::time::Instant::now();
    let out = exec(
        &ctx,
        "setTimeout(()=>text('late'),60000); text('done');",
        1000,
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(!out.content.contains("late"));
    let out = exec(
        &ctx,
        "text('before');try{exit()}catch{};text('after');",
        1000,
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert!(out.content.contains("before"));
    assert!(!out.content.contains("after"));
    pool.settle().await;
}
#[tokio::test]
async fn syntax_heap_output_and_store_limits_fail_without_poisoning_later_cells() {
    let (pool, ctx) = setup();
    for code in [
        "let = ;",
        "const a=[];for(let i=0;i<10000000;i++)a.push(i);",
        "text('x'.repeat(1048577));",
        "store('huge','x'.repeat(1048576));",
    ] {
        let out = exec(&ctx, code, 2000).await;
        assert!(out.is_error, "{code}: {}", out.content);
        assert!(!pool.has_running());
    }
    assert!(!exec(&ctx, "text(1+2)", 1000).await.is_error);
    pool.settle().await;
}
#[tokio::test]
async fn cancellation_and_conversation_ownership_do_not_leak_cells_or_values() {
    let (pool, ctx) = setup();
    let out = exec(&ctx, "store('key',1);await new Promise(()=>{});", 10).await;
    let cell = id(&out);
    let (other, second) = setup();
    assert!(wait(&second, &cell, true).await.is_error);
    assert!(
        exec(&second, "text(load('key'));", 1000)
            .await
            .content
            .ends_with("undefined")
    );
    ctx.cancel.cancel();
    pool.settle().await;
    assert!(!pool.has_running());
    other.settle().await;
}
struct Echo;
impl Tool for Echo {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "deferred_echo".into(),
            description: "echo".into(),
            schema: json!({"type":"object"}),
        }
    }
    fn deferred(&self) -> bool {
        true
    }
    fn call(&self, _ctx: ToolCtx, v: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move { ToolOutput::ok(v.to_string()) })
    }
}
#[tokio::test]
async fn deferred_tools_are_callable_but_omitted_grants_and_recursive_tools_are_absent() {
    let (pool, mut ctx) = setup();
    let mut registry = (*ctx.registry).clone();
    registry.register(Echo);
    ctx.registry = Arc::new(registry);
    let out=exec(&ctx,"const tool=ALL_TOOLS.find(t=>t.name==='deferred_echo');text(await tools[tool.name]({value:123}));text(Object.keys(tools));",1000).await;
    assert!(!out.is_error, "{}", out.content);
    assert!(out.content.contains("123"));
    assert!(!out.content.contains("code_mode"));
    let mut restricted = (*ctx.registry).clone();
    restricted.retain(|n| n != "deferred_echo");
    ctx.registry = Arc::new(restricted);
    let out = exec(
        &ctx,
        "text(ALL_TOOLS.some(t=>t.name==='deferred_echo'));text(typeof tools.deferred_echo);",
        1000,
    )
    .await;
    assert!(out.content.contains("false\nundefined"));
    pool.settle().await;
}
#[tokio::test]
async fn pragma_is_validated_and_image_output_is_explicit() {
    let (pool, ctx) = setup();
    let out = exec(&ctx, "// @exec: invalid\ntext(1)", 1000).await;
    assert!(out.is_error);
    let out = exec(
        &ctx,
        "image({type:'image',mimeType:'image/png',data:'aGVsbG8='});text('picture');",
        1000,
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert_eq!(out.images.len(), 1);
    let out = exec(&ctx, "image('https://example.com/image.png')", 1000).await;
    assert!(out.is_error);
    pool.settle().await;
}

#[tokio::test]
async fn audio_output_is_explicit_and_bounded() {
    let (pool, ctx) = setup();
    let out = exec(
        &ctx,
        "audio({mimeType:'audio/wav',data:'aGVsbG8='});text('sound');",
        1000,
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert_eq!(out.audio.len(), 1);
    assert_eq!(out.audio[0].mime, "audio/wav");
    let out = exec(&ctx, "audio({mimeType:'text/plain',data:'aGVsbG8='})", 1000).await;
    assert!(out.is_error);
    pool.settle().await;
}

#[tokio::test]
async fn explicit_yields_keep_their_boundaries_even_when_the_whole_script_finishes_immediately() {
    let (pool, ctx) = setup();
    let first = exec(
        &ctx,
        "text('one');await yield_control();text('two');await yield_control();text('three');",
        2000,
    )
    .await;
    let cell = id(&first);
    assert!(first.content.ends_with("one"));
    assert!(wait(&ctx, &cell, false).await.content.ends_with("two"));
    let last = wait(&ctx, &cell, false).await;
    assert!(last.content.starts_with("Script completed"));
    assert!(last.content.ends_with("three"));
    pool.settle().await;
}

#[tokio::test]
async fn host_argument_and_concurrency_limits_and_live_cell_cap_are_enforced() {
    let (pool, mut ctx) = setup();
    let mut r = (*ctx.registry).clone();
    r.register(Echo);
    ctx.registry = Arc::new(r);
    assert!(
        exec(
            &ctx,
            "await tools.deferred_echo({data:'x'.repeat(1048576)});",
            1000
        )
        .await
        .is_error
    );
    assert!(
        exec(
            &ctx,
            "await Promise.all(Array.from({length:17},()=>tools.deferred_echo({})));",
            1000
        )
        .await
        .is_error
    );
    for _ in 0..4 {
        let out = exec(&ctx, "await new Promise(()=>{});", 5).await;
        assert!(out.content.starts_with("Script running"), "{}", out.content);
    }
    assert!(exec(&ctx, "text('over limit');", 1000).await.is_error);
    pool.settle().await;
    assert!(!pool.has_running());
}
#[derive(Default)]
struct GateState {
    readers: std::sync::atomic::AtomicUsize,
    max_readers: std::sync::atomic::AtomicUsize,
    writing: std::sync::atomic::AtomicBool,
}
struct GateTool {
    state: Arc<GateState>,
    write: bool,
}
impl Tool for GateTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: if self.write {
                "guard_write"
            } else {
                "guard_read"
            }
            .into(),
            description: "test the shared execution gate".into(),
            schema: json!({"type":"object"}),
        }
    }
    fn mutates(&self) -> bool {
        self.write
    }
    fn call(&self, _ctx: ToolCtx, _args: Value) -> BoxFuture<'static, ToolOutput> {
        let state = self.state.clone();
        let write = self.write;
        Box::pin(async move {
            use std::sync::atomic::Ordering::SeqCst;
            if write {
                assert_eq!(state.readers.load(SeqCst), 0);
                assert!(!state.writing.swap(true, SeqCst));
                tokio::time::sleep(Duration::from_millis(20)).await;
                state.writing.store(false, SeqCst);
            } else {
                assert!(!state.writing.load(SeqCst));
                let readers = state.readers.fetch_add(1, SeqCst) + 1;
                state.max_readers.fetch_max(readers, SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                assert!(!state.writing.load(SeqCst));
                state.readers.fetch_sub(1, SeqCst);
            }
            ToolOutput::ok("done")
        })
    }
}
#[tokio::test]
async fn nested_reads_share_the_direct_tool_gate_and_writes_still_run_exclusively() {
    use fv_agent::{
        AgentContext, run_turn,
        testing::{Reply, ScriptedModel},
    };
    let pool = Arc::new(CodeMode::default());
    let mut tools = ToolRegistry::new();
    pool.register(&mut tools);
    let state = Arc::new(GateState::default());
    tools
        .register(GateTool {
            state: state.clone(),
            write: false,
        })
        .register(GateTool {
            state: state.clone(),
            write: true,
        });
    let model=Arc::new(ScriptedModel::new([Reply::new().tool("script","code_mode",json!({"code":"await Promise.all([tools.guard_read({}),tools.guard_read({})]);text(await tools.guard_write({}));"})).tool("direct","guard_write",json!({})).done(),Reply::new().text("done").done()]));
    let context = AgentContext {
        context: Default::default(),
        hooks: None,
        model,
        tools: Arc::new(tools),
        system: String::new(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
        permissions: None,
        steer: None,
        memory: None,
        budget: Default::default(),
        compaction: None,
    };
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut history = Vec::new();
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        run_turn(
            &context,
            &mut history,
            "parallel orchestration".into(),
            &tx,
            &CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(result, fv_agent::TurnOutcome::Completed);
    assert_eq!(
        state.max_readers.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    assert!(
        history
            .iter()
            .all(|m| !matches!(m, fv_core::Message::ToolResult { is_error: true, .. }))
    );
    assert!(!pool.has_running());
}
