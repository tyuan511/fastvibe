//! Real CLI smoke test: two turns + tool execution + reopen + resume.
use fastvibe_core::{
    harness::*,
    repository::{MessageRepository, Repository},
    session::ReasoningLevel,
};
use std::path::PathBuf;
fn main() -> anyhow::Result<()> {
    let which = std::env::args().nth(1).unwrap_or("codex".into());
    let model = std::env::args().nth(2).unwrap_or("default".into());
    let id = if which == "codex" {
        HarnessId::Codex
    } else {
        HarnessId::ClaudeCode
    };
    let dir = std::env::temp_dir().join(format!("fastvibe-smoke-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let marker = format!("FV-{}", uuid::Uuid::new_v4());
    std::fs::write(dir.join("marker.txt"), &marker)?;
    let path = dir.join("fastvibe.db");
    let repo = Repository::open(&path)?;
    let p = repo.add_project(dir.clone())?;
    let session = repo.create_session(p)?;
    repo.selection(session, id, model, ReasoningLevel::Low)?;
    drop(repo);
    for (i,prompt) in ["Read marker.txt using a file or shell tool. Remember its exact contents for later. Reply only 'saved'.", "What was the exact code in marker.txt from the previous turn? Reply with only that code. Do not use tools this turn."].iter().enumerate() {
        let repo=Repository::open(&path)?;let request=repo.prepare(session,prompt)?;
        println!("turn={} harness={} resume={}",i+1,id.label(),request.request.session_id.is_some());
        if i==1 {anyhow::ensure!(request.request.session_id.is_some(),"Second turn was not resumed");}
        let harness=default_harnesses().into_iter().find(|h|h.id()==id).unwrap();
        let run=harness.run(request.request);let runid=request.run_id;let mut terminal=false;
        while let Ok(e)=run.events.recv_blocking(){repo.apply(runid,&e)?;if let AgentEvent::Finished{state,error}=e {println!("turn={} state={state:?}",i+1);anyhow::ensure!(state==RunState::Completed,"{}",error.unwrap_or_default());terminal=true;break}}
        anyhow::ensure!(terminal,"Missing terminal event");
        let messages=repo.messages(session)?;
        if i==0{anyhow::ensure!(messages.iter().any(|m|m.kind==ContentKind::Tool),"No tool call was recorded");}
        if i==1 {anyhow::ensure!(messages.iter().filter(|m|m.run_id==runid && m.kind==ContentKind::Text).any(|m|m.role==fastvibe_core::Role::Assistant && m.content.contains(&marker)),"Resumed answer lost earlier context");}
        println!("stored_messages={} remote_id={}",messages.len(),repo.session(session)?.binding.is_some());
    }
    let _ = PathBuf::from(".");
    println!(
        "PASS: real tool execution, model arguments, two turns, DB reopen/resume; fixture={}",
        dir.display()
    );
    Ok(())
}
