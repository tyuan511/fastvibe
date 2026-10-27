use super::{Cell, CodeMode};
use fv_agent::ToolCtx;
use rquickjs::{
    AsyncContext, AsyncRuntime, CatchResultExt, Ctx, Exception, Function, Module,
    prelude::{Async, Func},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};
fn failure<'js>(ctx: &Ctx<'js>, error: impl std::fmt::Display) -> rquickjs::Error {
    Exception::throw_message(ctx, &error.to_string())
}
fn host_error(error: impl std::fmt::Display) -> rquickjs::Error {
    rquickjs::Error::new_from_js_message("native tool", "JavaScript", error.to_string())
}
pub(super) async fn run(
    pool: Arc<CodeMode>,
    cell: Arc<Cell>,
    tools_ctx: ToolCtx,
    host: tokio::runtime::Handle,
    source: String,
) -> Result<(), String> {
    let jobs: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Default::default();
    let runtime = AsyncRuntime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(64 * 1024 * 1024).await;
    runtime.set_max_stack_size(512 * 1024).await;
    let limit = Instant::now() + Duration::from_secs(600);
    let interrupted = cell.cancel.clone();
    runtime
        .set_interrupt_handler(Some(Box::new(move || {
            interrupted.is_cancelled() || Instant::now() >= limit
        })))
        .await;
    let context = AsyncContext::full(&runtime)
        .await
        .map_err(|e| e.to_string())?;
    let result=context.async_with(async |js| -> rquickjs::Result<()> {
        let globals=js.globals();
        let counter=Arc::new(AtomicU32::new(0));
        let catalog=tools_ctx.registry.all_specs().into_iter().filter(|s|tools_ctx.registry.get(&s.name).is_some_and(|t|t.enabled(&tools_ctx.registry)&&!t.orchestrates()&&!t.hosted())).map(|s|json!({"name":s.name,"description":s.description,"schema":s.schema})).collect::<Vec<_>>();
        globals.set("__catalog",serde_json::to_string(&catalog).unwrap())?;
        let output=cell.clone();globals.set("__text",Func::from(move|ctx:Ctx<'_>,s:String|{if output.exited.load(Ordering::Acquire){return Err(failure(&ctx,"Script exited"));}output.text(s).map_err(|e|failure(&ctx,e))}))?;
        let output=cell.clone();globals.set("__exit",Func::from(move|ctx:Ctx<'_>|{output.exited.store(true,Ordering::Release);output.cancel.cancel();Err::<(),_>(failure(&ctx,"Script exited"))}))?;
        let output=cell.clone();globals.set("__image",Func::from(move|ctx:Ctx<'_>,s:String|{let value=serde_json::from_str(&s).map_err(|e|failure(&ctx,e))?;output.image(value).map_err(|e|failure(&ctx,e))}))?;
        let output=cell.clone();globals.set("__audio",Func::from(move|ctx:Ctx<'_>,s:String|{let value=serde_json::from_str(&s).map_err(|e|failure(&ctx,e))?;output.audio(value).map_err(|e|failure(&ctx,e))}))?;
        let stored=pool.clone();let running=cell.clone();globals.set("__store",Func::from(move|ctx:Ctx<'_>,key:String,s:String|{if running.exited.load(Ordering::Acquire){return Err(failure(&ctx,"Script exited"));}let value=serde_json::from_str(&s).map_err(|e|failure(&ctx,e))?;stored.stored(key,value).map_err(|e|failure(&ctx,e))}))?;
        let stored=pool.clone();globals.set("__load",Func::from(move|key:String|stored.values.lock().unwrap().get(&key).map(|v|v.to_string())))?;
        let output=cell.clone();globals.set("__yield",Func::from(move|ctx:Ctx<'_>|output.yield_now().map_err(|e|failure(&ctx,e))))?;
        globals.set("__delay",Function::new(js.clone(),Async(move|ms:u64|async move{tokio::time::sleep(Duration::from_millis(ms.min(600_000))).await;Ok::<_,rquickjs::Error>(())}))?)?;
        let pending=jobs.clone();let active=cell.clone();let dispatch=tools_ctx.nested.clone().unwrap();let slots=Arc::new(tokio::sync::Semaphore::new(16));
        globals.set("__call",Function::new(js.clone(),Async(move|name:String,args:String|{
            let pending=pending.clone();let active=active.clone();let dispatch=dispatch.clone();let host=host.clone();let mut tools_ctx=tools_ctx.clone();let counter=counter.clone();
            // Bound host-side captures before constructing the promise; otherwise a
            // synchronous JS loop could retain Rust strings outside the JS heap limit.
            let number=counter.fetch_add(1,Ordering::AcqRel);
            let permit=slots.clone().try_acquire_owned().map_err(|_|"At most 16 concurrent nested calls per cell.");
            let args=if number>=256{Err("At most 256 nested tool calls per cell.")}else if args.len()>1024*1024{Err("Nested tool arguments exceed 1 MiB.")}else if permit.is_err(){Err("At most 16 concurrent nested calls per cell.")}else{Ok(args)};
            async move{
                let _permit=permit.map_err(host_error)?;
                if active.cancel.is_cancelled(){return Err(host_error("Script ended before this call started."));}
                let args=args.map_err(host_error)?;
                let arguments:Value=serde_json::from_str(&args).map_err(host_error)?;
                if !arguments.is_object(){return Err(host_error("Native tool arguments must be JSON objects."));}
                tools_ctx.call_id=format!("{}/code/{}/{number}",tools_ctx.call_id,active.id);
                // Completed tools may have returned a background process handle. Those
                // belong to the turn, not the ephemeral JS cell. Cancel only still-pending
                // dispatches when this cell ends; user interruption still reaches all of them.
                let call_cancel=tools_ctx.cancel.child_token();tools_ctx.cancel=call_cancel.clone();
                let(tx,rx)=tokio::sync::oneshot::channel();
                pending.lock().unwrap().push(host.spawn(async move{
                    let run=dispatch.call(tools_ctx,name,arguments);tokio::pin!(run);
                    let out=tokio::select!{biased;out=&mut run=>out,_ = active.cancel.cancelled()=>{call_cancel.cancel();run.await}};
                    let _=tx.send(out);
                }));
                let out=rx.await.map_err(|_|host_error("The native tool dispatcher stopped."))?;
                if out.is_error{return Err(host_error(out.content));}
                let mut value=serde_json::from_str::<Value>(&out.content).unwrap_or(Value::String(out.content));
                if !out.images.is_empty(){
                    use base64::Engine;
                    let images=out.images.into_iter().map(|image|{
                        let data=match image.source{fv_core::ImageSource::Base64{data}=>Ok(data),fv_core::ImageSource::File{path}=>std::fs::read(path).map(|bytes|base64::engine::general_purpose::STANDARD.encode(bytes))};
                        data.map(|data|json!({"type":"image","mimeType":image.mime,"data":data}))
                    }).collect::<Result<Vec<_>,_>>().map_err(host_error)?;
                    if !value.is_object(){value=json!({"text":value});}value.as_object_mut().unwrap().insert("images".into(),json!(images));
                }
                if !out.audio.is_empty(){
                    use base64::Engine;
                    let audio=out.audio.into_iter().map(|clip|{
                        let data=match clip.source{fv_core::AudioSource::Base64{data}=>Ok(data),fv_core::AudioSource::File{path}=>std::fs::read(path).map(|bytes|base64::engine::general_purpose::STANDARD.encode(bytes))};
                        data.map(|data|json!({"type":"audio","mimeType":clip.mime,"data":data}))
                    }).collect::<Result<Vec<_>,_>>().map_err(host_error)?;
                    if !value.is_object(){value=json!({"text":value});}value.as_object_mut().unwrap().insert("audio".into(),json!(audio));
                }
                Ok::<_,rquickjs::Error>(value.to_string())
            }
        }))?)?;
        js.eval::<(),_>(include_str!("bootstrap.js"))?;
        let execution=async{Module::evaluate(js.clone(),"fastvibe-cell.mjs",source)?.into_future::<()>().await};
        let result=tokio::select!{biased;_ = cell.cancel.cancelled()=>Err(failure(&js,"Code-mode cell cancelled.")),_ = tokio::time::sleep_until(tokio::time::Instant::from_std(limit))=>Err(failure(&js,"Code-mode cell exceeded its 10-minute limit.")),result=execution=>result};
        if cell.exited.load(Ordering::Acquire){Ok(())}else{result}
    }).await;
    let error = context
        .with(|ctx| result.catch(&ctx).map_err(|e| e.to_string()))
        .await;
    // End-of-module discards unawaited work, but don't release the worker slot or announce
    // completion until every host dispatch has observed cancellation and returned.
    cell.cancel.cancel();
    let pending = std::mem::take(&mut *jobs.lock().unwrap());
    for job in pending {
        let _ = job.await;
    }
    drop(context);
    drop(runtime);
    error
}
