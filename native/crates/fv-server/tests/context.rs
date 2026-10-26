use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::context::ContextLoader;
use fv_server::{ServerState, UnixServer};

mod common;

fn write(path: impl AsRef<Path>, text: &str) {
    let path = path.as_ref();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn skill(path: impl AsRef<Path>, name: &str, description: &str, body: &str) {
    write(
        path,
        &format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}"),
    );
}

#[test]
fn instructions_follow_repository_scope_override_precedence_and_refresh_from_disk() {
    let data = tempfile::tempdir().unwrap();
    let home = data.path().join("home");
    let repo = home.join("repo");
    let cwd = repo.join("nested/deeper");
    fs::create_dir_all(&cwd).unwrap();
    write(repo.join(".git"), "gitdir: /some/worktree");
    write(home.join("AGENTS.md"), "OUTSIDE_REPOSITORY");
    write(home.join(".agents/AGENTS.md"), "GLOBAL_INSTRUCTIONS");
    write(repo.join("AGENTS.md"), "ROOT_INSTRUCTIONS");
    write(repo.join("nested/AGENTS.md"), "SHADOWED_INSTRUCTIONS");
    write(repo.join("nested/AGENTS.override.md"), "NESTED_OVERRIDE");
    write(cwd.join("AGENTS.override.md"), "   \n");
    write(cwd.join("AGENTS.md"), "EMPTY_OVERRIDE_FALLBACK");
    write(repo.join("sibling/AGENTS.md"), "SIBLING_INSTRUCTIONS");
    let loader = ContextLoader::with_roots(data.path(), Some(home), vec![]);
    let (text, errors) = loader.instructions(Some(&cwd));
    assert!(errors.is_empty());
    assert!(text.find("GLOBAL_INSTRUCTIONS").unwrap() < text.find("ROOT_INSTRUCTIONS").unwrap());
    assert!(text.find("ROOT_INSTRUCTIONS").unwrap() < text.find("NESTED_OVERRIDE").unwrap());
    assert!(text.contains("EMPTY_OVERRIDE_FALLBACK"));
    for absent in [
        "OUTSIDE_REPOSITORY",
        "SHADOWED_INSTRUCTIONS",
        "SIBLING_INSTRUCTIONS",
    ] {
        assert!(!text.contains(absent));
    }
    write(repo.join("AGENTS.md"), "CHANGED_INSTRUCTIONS");
    assert!(
        loader
            .instructions(Some(&cwd))
            .0
            .contains("CHANGED_INSTRUCTIONS")
    );
}

#[test]
fn skills_parse_yaml_report_collisions_and_only_load_full_bodies_when_selected() {
    let data = tempfile::tempdir().unwrap();
    let home = data.path().join("home");
    let builtin = data.path().join("builtin");
    let repo = data.path().join("repo");
    write(repo.join(".git"), "");
    skill(
        repo.join(".agents/skills/review/SKILL.md"),
        "review",
        ">\n  Review code\n  carefully",
        "PROJECT_FULL_BODY",
    );
    skill(
        home.join(".agents/skills/review/SKILL.md"),
        "review",
        "Global version",
        "GLOBAL_FULL_BODY",
    );
    skill(
        builtin.join("review/SKILL.md"),
        "review",
        "Builtin version",
        "BUILTIN_FULL_BODY",
    );
    write(
        builtin.join("manual/SKILL.md"),
        "---\r\nname: manual\r\ndescription: 'Run: manually'\r\ndisable-model-invocation: true\r\n---\r\nMANUAL_FULL_BODY",
    );
    write(
        builtin.join("invalid/SKILL.md"),
        "---\nname: invalid\n---\n",
    );
    let loader = ContextLoader::with_roots(data.path(), Some(home), vec![builtin]);
    let catalog = loader.list(Some(&repo));
    assert_eq!(catalog.skills.len(), 2);
    let review = catalog.skills.iter().find(|s| s.name == "review").unwrap();
    assert_eq!(review.scope, SkillScope::Project);
    assert_eq!(review.description, "Review code carefully");
    assert!(!review.removable);
    assert!(catalog.diagnostics.iter().any(|d| d.contains("shadows")));
    assert!(catalog.diagnostics.iter().any(|d| d.contains("invalid")));
    let prompt = loader.prompt(Some(&repo), Some("review this"));
    assert!(!prompt.contains("PROJECT_FULL_BODY"));
    assert!(!prompt.contains("MANUAL_FULL_BODY"));
    assert!(
        loader
            .prompt(Some(&repo), Some("/skill:manual run"))
            .contains("MANUAL_FULL_BODY")
    );
    assert!(
        loader
            .prompt(Some(&repo), Some("/skill:review run"))
            .contains("PROJECT_FULL_BODY")
    );
    assert!(loader.remove(Some(&repo), "review").is_err());
}

#[test]
fn skill_import_copies_resources_and_rejects_links_without_leaving_partial_skills() {
    use std::os::unix::fs::symlink;
    let data = tempfile::tempdir().unwrap();
    let store = data.path().join("store");
    let source = data.path().join("source");
    let loader = ContextLoader::with_roots(&store, None, vec![]);
    skill(
        source.join("SKILL.md"),
        "example",
        "An example",
        "See scripts/run.sh",
    );
    write(source.join("scripts/run.sh"), "echo hello");
    symlink("/etc/passwd", source.join("escape")).unwrap();
    assert!(loader.import(&source).is_err());
    assert!(loader.list(None).skills.is_empty());
    assert!(!store.join("skills/example").exists());
    fs::remove_file(source.join("escape")).unwrap();
    loader.import(&source).unwrap();
    assert_eq!(
        fs::read_to_string(store.join("skills/example/scripts/run.sh")).unwrap(),
        "echo hello"
    );
    assert!(
        loader.import(&source).is_err(),
        "never overwrite an existing skill"
    );
    let s = loader.read(None, "example").unwrap();
    assert!(s.skill.removable);
    loader.remove(None, "example").unwrap();
    assert!(source.join("scripts/run.sh").exists());
    assert!(loader.list(None).skills.is_empty());
}

#[test]
fn importing_a_collection_rolls_back_its_own_files_without_touching_an_existing_skill() {
    let data = tempfile::tempdir().unwrap();
    let store = data.path().join("store");
    let source = data.path().join("collection");
    let loader = ContextLoader::with_roots(&store, None, vec![]);
    for name in ["first", "second"] {
        skill(
            source.join(name).join("SKILL.md"),
            name,
            "Example skill",
            "BODY",
        );
    }
    loader
        .create(SkillCreateParams {
            name: "second".into(),
            description: "Existing skill".into(),
            body: "ORIGINAL".into(),
        })
        .unwrap();
    assert!(loader.import(&source).is_err());
    assert!(!store.join("skills/first").exists());
    assert!(
        loader
            .read(None, "second")
            .unwrap()
            .content
            .contains("ORIGINAL")
    );
    loader.remove(None, "second").unwrap();
    loader.import(&source).unwrap();
    assert_eq!(loader.list(None).skills.len(), 2);
    let restarted = ContextLoader::with_roots(&store, None, vec![]);
    assert_eq!(restarted.list(None).skills.len(), 2);
}

#[test]
fn oversize_instructions_and_invalid_skills_are_visible_failures() {
    let data = tempfile::tempdir().unwrap();
    write(data.path().join(".git"), "");
    write(data.path().join("AGENTS.md"), &"x".repeat(1024 * 1024 + 1));
    let loader = ContextLoader::with_roots(data.path(), None, vec![]);
    assert!(loader.instructions(Some(data.path())).0.is_empty());
    assert!(
        loader
            .prompt(Some(data.path()), None)
            .contains("1 MiB limit")
    );
    for name in ["../escape", "UPPER", "-bad", "bad--name", ""] {
        assert!(
            loader
                .create(SkillCreateParams {
                    name: name.into(),
                    description: "desc".into(),
                    body: "body".into()
                })
                .is_err()
        );
    }
    assert!(loader.list(None).skills.is_empty());
}

async fn idle(notes: &mut tokio::sync::mpsc::UnboundedReceiver<ServerNotification>) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(note) = notes.recv().await {
            if let ServerNotification::ThreadStatusChanged(e) = note
                && !e.body.running
            {
                return;
            }
        }
        panic!("connection ended before turn completed");
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn public_skill_methods_and_model_requests_use_the_same_per_thread_context() {
    let data = tempfile::tempdir().unwrap();
    let repo = data.path().join("repo");
    write(repo.join(".git"), "");
    write(repo.join("AGENTS.md"), "PROJECT_RULE_ONE");
    let model = Arc::new(ScriptedModel::new([
        Reply::new().text("first").done(),
        Reply::new().text("second").done(),
        Reply::new().text("other project").done(),
    ]));
    let mut state = ServerState::new(
        data.path().to_path_buf(),
        fv_server::agent_with_builtin_tools(model.clone()),
    )
    .unwrap();
    state.context = ContextLoader::with_roots(data.path(), None, vec![]);
    common::disable_reply_suggestions(&state);
    let state = Arc::new(state);
    let sock = data.path().join("server.sock");
    let server = tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    let (client, mut notes) = Client::connect_unix(&sock).await.unwrap();
    client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    client
        .call::<SkillCreate>(SkillCreateParams {
            name: "example".into(),
            description: "A sample workflow".into(),
            body: "EXPLICIT_SKILL_BODY".into(),
        })
        .await
        .unwrap();
    let list = client
        .call::<SkillList>(SkillListParams {
            cwd: Some(repo.display().to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(list.skills.len(), 1);
    assert!(list.skills[0].removable);
    let read = client
        .call::<SkillRead>(SkillNameParams {
            cwd: None,
            other_folders: Vec::new(),
            name: "example".into(),
        })
        .await
        .unwrap();
    assert!(read.content.contains("EXPLICIT_SKILL_BODY"));
    let support = data.path().join("support");
    write(support.join(".git"), "");
    write(support.join("AGENTS.md"), "SUPPORT_FOLDER_RULE");
    skill(
        support.join(".agents/skills/support/SKILL.md"),
        "support",
        "Support workflow",
        "SUPPORT_SKILL_BODY",
    );
    client
        .call::<ProjectCreate>(ProjectCreateParams {
            name: Some("Multi-folder".into()),
            folders: vec![repo.display().to_string(), support.display().to_string()],
        })
        .await
        .unwrap();
    let multi_catalog = client
        .call::<SkillList>(SkillListParams {
            cwd: Some(repo.display().to_string()),
            other_folders: vec![support.display().to_string()],
        })
        .await
        .unwrap();
    assert!(multi_catalog.skills.iter().any(|s| s.name == "support"));
    let id = client
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(repo.display().to_string()),
            project: Some(repo.display().to_string()),
            ..Default::default()
        })
        .await
        .unwrap()
        .thread
        .id;
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: id.clone(),
            text: "/skill:example do this".into(),
        })
        .await
        .unwrap();
    idle(&mut notes).await;
    assert!(model.requests()[0].system.contains("PROJECT_RULE_ONE"));
    assert_eq!(
        model.requests()[0]
            .system
            .matches("PROJECT_RULE_ONE")
            .count(),
        1
    );
    assert!(model.requests()[0].system.contains("EXPLICIT_SKILL_BODY"));
    assert!(model.requests()[0].system.contains("SUPPORT_FOLDER_RULE"));
    assert!(model.requests()[0].system.contains("Support workflow"));
    assert!(!model.requests()[0].system.contains("SUPPORT_SKILL_BODY"));
    write(repo.join("AGENTS.md"), "PROJECT_RULE_TWO");
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: id,
            text: "continue".into(),
        })
        .await
        .unwrap();
    idle(&mut notes).await;
    assert!(model.requests()[1].system.contains("PROJECT_RULE_TWO"));
    assert!(!model.requests()[1].system.contains("PROJECT_RULE_ONE"));
    let other = data.path().join("other");
    write(other.join(".git"), "");
    write(other.join("AGENTS.md"), "OTHER_PROJECT_RULE");
    let other_id = client
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(other.display().to_string()),
            ..Default::default()
        })
        .await
        .unwrap()
        .thread
        .id;
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: other_id,
            text: "hello".into(),
        })
        .await
        .unwrap();
    idle(&mut notes).await;
    let other_request = &model.requests()[2];
    assert!(other_request.system.contains("OTHER_PROJECT_RULE"));
    assert!(!other_request.system.contains("PROJECT_RULE_TWO"));
    assert!(!other_request.system.contains("EXPLICIT_SKILL_BODY"));
    assert!(!other_request.system.contains("SUPPORT_FOLDER_RULE"));
    client
        .call::<SkillRemove>(SkillNameParams {
            cwd: None,
            other_folders: Vec::new(),
            name: "example".into(),
        })
        .await
        .unwrap();
    assert!(
        client
            .call::<SkillList>(SkillListParams::default())
            .await
            .unwrap()
            .skills
            .is_empty()
    );
    server.abort();
}
