use crate::{Cookie, engines};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tokio::process::{Child, Command};

pub struct SystemBrowser {
    root: Option<PathBuf>,
    process: Option<Child>,
    temporary_root: Option<tempfile::TempDir>,
    engine: String,
    port: u16,
    tabs: HashMap<String, (String, String)>,
    client: reqwest::Client,
}
impl SystemBrowser {
    /// Use a caller-owned profile root. Its files are never removed by this instance.
    pub fn new(root: PathBuf) -> Self {
        Self::with_root(Some(root))
    }

    /// A window's isolated profile, allocated on first use and owned until the last Arc drops.
    pub fn temporary() -> Self {
        Self::with_root(None)
    }

    fn with_root(root: Option<PathBuf>) -> Self {
        Self {
            root,
            process: None,
            temporary_root: None,
            engine: String::new(),
            port: 0,
            tabs: HashMap::new(),
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .expect("local HTTP client"),
        }
    }
    fn profile_root(&mut self) -> Result<&std::path::Path, String> {
        if let Some(root) = &self.root {
            return Ok(root.as_path());
        }
        if self.temporary_root.is_none() {
            self.temporary_root = Some(
                tempfile::Builder::new()
                    .prefix("fastvibe-browser-profile-")
                    .tempdir()
                    .map_err(|e| e.to_string())?,
            );
        }
        Ok(self.temporary_root.as_ref().unwrap().path())
    }

    async fn ensure(&mut self, choice: &str) -> Result<(), String> {
        let available = engines();
        let engine = if choice == "auto" { available.first() } else { available.iter().find(|e| e.id == choice) }.ok_or("没有找到所选浏览器，请安装 Chrome、Edge 或 Chromium / Selected browser is not installed")?;
        if self.engine == engine.id
            && self
                .process
                .as_mut()
                .is_some_and(|p| p.try_wait().ok().flatten().is_none())
            && self.port != 0
        {
            return Ok(());
        }
        if let Some(mut child) = self.process.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.port = 0;
        self.tabs.clear();
        let profile = self.profile_root()?.join(engine.id);
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        // A stale port file is never permission to attach to another process.
        let port_file = profile.join("DevToolsActivePort");
        let _ = std::fs::remove_file(&port_file);
        let child = Command::new(&engine.binary)
            .arg(format!("--user-data-dir={}", profile.display()))
            .args([
                "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1",
                "--no-first-run",
                "--no-default-browser-check",
                "about:blank",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        self.process = Some(child);
        self.engine = engine.id.into();
        for _ in 0..60 {
            if self
                .process
                .as_mut()
                .unwrap()
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err("Browser exited before opening its debugging port".into());
            }
            if let Ok(file) = std::fs::read_to_string(&port_file)
                && let Some(port) = file.lines().next().and_then(|p| p.parse::<u16>().ok())
                && port != 0
                && self
                    .client
                    .get(format!("http://127.0.0.1:{port}/json/version"))
                    .send()
                    .await
                    .is_ok()
            {
                self.port = port;
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("Timed out starting the system browser".into())
    }
    async fn targets(&self) -> Result<Vec<Value>, String> {
        self.client
            .get(format!("http://127.0.0.1:{}/json/list", self.port))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }
    async fn target(
        &mut self,
        owner: &str,
        new_tab: bool,
        requested: Option<&str>,
    ) -> Result<Value, String> {
        let targets = self.targets().await?;
        if !new_tab && let Some(id) = requested.map(|v| v.strip_prefix("cdp:").unwrap_or(v)) {
            // An explicit tab is an exact target, including after it was closed. Falling
            // back to the owner's current tab would send a click or text to another page.
            let target = targets
                .iter()
                .find(|t| t["id"].as_str() == Some(id) && t["type"] == "page")
                .ok_or("The requested browser tab is no longer available. List tabs and select it again.")?;
            self.tabs.insert(
                owner.into(),
                (
                    id.into(),
                    target["url"].as_str().unwrap_or("about:blank").into(),
                ),
            );
            return Ok(target.clone());
        }
        if !new_tab
            && let Some((id, _)) = self.tabs.get(owner)
            && let Some(t) = targets.iter().find(|t| t["id"].as_str() == Some(id))
        {
            return Ok(t.clone());
        }
        let last = self
            .tabs
            .get(owner)
            .map(|(_, url)| url.clone())
            .unwrap_or_else(|| "about:blank".into());
        let target: Value = self
            .client
            .put(format!(
                "http://127.0.0.1:{}/json/new?about:blank",
                self.port
            ))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let id = target["id"]
            .as_str()
            .ok_or("No browser target")?
            .to_string();
        self.tabs.insert(owner.into(), (id, last.clone()));
        if !new_tab && last != "about:blank" {
            call(&target, "Page.navigate", json!({"url":last})).await?;
        }
        Ok(target)
    }
    /// A single request holds the caller's mutex, keeping navigation and evaluations ordered.
    #[expect(
        clippy::too_many_arguments,
        reason = "The existing browser action boundary keeps engine, owner, target and operation explicit"
    )]
    pub async fn run(
        &mut self,
        engine: &str,
        owner: &str,
        action: &str,
        url: Option<&str>,
        script: Option<&str>,
        new_tab: bool,
        tab_id: Option<&str>,
    ) -> Result<String, String> {
        self.ensure(engine).await?;
        if action == "list" {
            let tabs: Vec<_>=self.targets().await?.into_iter().filter(|v|v["type"]=="page").map(|v|json!({"tabId":format!("cdp:{}",v["id"].as_str().unwrap_or("")),"url":v["url"],"title":v["title"]})).collect();
            return serde_json::to_string(&tabs).map_err(|e| e.to_string());
        }
        let target = self.target(owner, new_tab, tab_id).await?;
        match action {
            "open" | "navigate" | "search" => {
                let url = url.ok_or("url is required")?;
                let outcome = call(&target, "Page.navigate", json!({"url":url})).await?;
                if let Some(error) = outcome["errorText"].as_str() {
                    return Err(error.into());
                }
                if let Some((_, last)) = self.tabs.get_mut(owner) {
                    *last = url.into();
                }
                wait_loaded(&target).await?;
            }
            "reload" => {
                call(&target, "Page.reload", json!({})).await?;
                wait_loaded(&target).await?;
            }
            "back" | "forward" => {
                let history = call(&target, "Page.getNavigationHistory", json!({})).await?;
                let at = history["currentIndex"].as_i64().unwrap_or(0)
                    + if action == "back" { -1 } else { 1 };
                if at >= 0
                    && let Some(entry) = history["entries"].get(at as usize)
                {
                    call(
                        &target,
                        "Page.navigateToHistoryEntry",
                        json!({"entryId":entry["id"]}),
                    )
                    .await?;
                    wait_loaded(&target).await?;
                }
            }
            _ => {
                let script = script.ok_or("No page script for action")?;
                let outcome = evaluate(&target, script).await?;
                // Remember redirects and page-initiated navigations too, for crash recovery.
                if let Ok(location) = evaluate(&target, "location.href").await
                    && let Some((_, last)) = self.tabs.get_mut(owner)
                {
                    *last = location;
                }
                if let Some(error) = outcome.strip_prefix("ERR:") {
                    return Err(error.into());
                }
                return Ok(format!(
                    "tabId: cdp:{}\n{outcome}",
                    target["id"].as_str().unwrap_or("")
                ));
            }
        }
        let location = evaluate(&target, "location.href").await?;
        if let Some((_, last)) = self.tabs.get_mut(owner) {
            *last = location.clone();
        }
        Ok(format!(
            "tabId: cdp:{}\n{action}: {location}",
            target["id"].as_str().unwrap_or("")
        ))
    }
    pub async fn import(&mut self, engine: &str, cookies: &[Cookie]) -> Result<usize, String> {
        self.ensure(engine).await?;
        let target = self.target("__cookie_import__", false, None).await?;
        let mut written = 0;
        for cookie in cookies {
            let mut value = serde_json::to_value(cookie).map_err(|e| e.to_string())?;
            if cookie.name.starts_with("__Host-") {
                value.as_object_mut().unwrap().remove("domain");
                value["url"] = json!(format!(
                    "https://{}/",
                    cookie.domain.trim_start_matches('.')
                ));
            }
            if call(&target, "Network.setCookie", value)
                .await
                .is_ok_and(|r| r["success"].as_bool().unwrap_or(true))
            {
                written += 1;
            }
        }
        Ok(written)
    }
}
impl Drop for SystemBrowser {
    fn drop(&mut self) {
        let mut process = self.process.take();
        let temporary_root = self.temporary_root.take();
        if process.is_none() && temporary_root.is_none() {
            return;
        }
        if let Some(child) = &mut process {
            let _ = child.start_kill();
        }
        // Reaping and removing a Chromium profile can take time. Neither belongs on the GUI
        // thread, and the owned directory must outlive the child that was using it.
        let _ = std::thread::Builder::new()
            .name("fv-browser-cleanup".into())
            .spawn(move || {
                if let Some(mut child) = process {
                    let deadline = std::time::Instant::now() + Duration::from_secs(3);
                    let reaped = loop {
                        match child.try_wait() {
                            Ok(Some(_)) => break true,
                            Err(_) => break false,
                            Ok(None) if std::time::Instant::now() >= deadline => break false,
                            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                        }
                    };
                    if !reaped {
                        // Do not remove a profile while its process may still be alive. Only
                        // this instance's directory is retained when best-effort reaping fails.
                        if let Some(root) = temporary_root {
                            let _ = root.keep();
                        }
                        return;
                    }
                }
                drop(temporary_root);
            });
    }
}

async fn wait_loaded(target: &Value) -> Result<(), String> {
    tokio::time::sleep(Duration::from_millis(150)).await;
    for _ in 0..60 {
        if evaluate(target, "document.readyState").await.as_deref() == Ok("complete") {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Err("Page is still loading; take a snapshot to inspect it".into())
}
async fn evaluate(target: &Value, expression: &str) -> Result<String, String> {
    let value = call(
        target,
        "Runtime.evaluate",
        json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
    )
    .await?;
    if let Some(error) = value.get("exceptionDetails") {
        return Err(error["text"]
            .as_str()
            .unwrap_or("Page script failed")
            .into());
    }
    let value = &value["result"]["value"];
    Ok(value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string()))
}
async fn call(target: &Value, method: &str, params: Value) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let endpoint = target["webSocketDebuggerUrl"]
            .as_str()
            .ok_or("No debugger endpoint")?;
        let (mut ws, _) = tokio_tungstenite::connect_async(endpoint)
            .await
            .map_err(|e| e.to_string())?;
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            json!({"id":1,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .map_err(|e| e.to_string())?;
        while let Some(message) = ws.next().await {
            let message = message.map_err(|e| e.to_string())?;
            if let Ok(s) = message.to_text()
                && let Ok(value) = serde_json::from_str::<Value>(s)
                && value["id"] == 1
            {
                if let Some(error) = value.get("error") {
                    return Err(error["message"]
                        .as_str()
                        .unwrap_or("Browser command failed")
                        .into());
                }
                return Ok(value["result"].clone());
            }
        }
        Err("Browser connection closed".into())
    })
    .await
    .map_err(|_| "Browser command timed out".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn temporary_profiles_are_lazy_unique_and_live_until_the_last_owner_drops() {
        use std::sync::{Arc, Mutex};
        let first = Arc::new(Mutex::new(SystemBrowser::temporary()));
        let mut second = SystemBrowser::temporary();
        assert!(first.lock().unwrap().temporary_root.is_none());
        assert!(second.temporary_root.is_none());
        let first_root = first.lock().unwrap().profile_root().unwrap().to_path_buf();
        let second_root = second.profile_root().unwrap().to_path_buf();
        assert_ne!(first_root, second_root);
        std::fs::write(first_root.join("Cookies"), b"first-window").unwrap();
        assert!(!second_root.join("Cookies").exists());
        let retained = first.clone();
        drop(first);
        assert!(first_root.join("Cookies").exists());
        drop(second);
        wait_until_removed(&second_root).await;
        assert!(
            first_root.exists(),
            "another browser's cleanup cannot touch this profile"
        );
        drop(retained);
        wait_until_removed(&first_root).await;
    }

    #[test]
    fn caller_owned_profiles_are_never_removed() {
        let root = tempfile::tempdir().unwrap();
        let sentinel = root.path().join("Cookies");
        std::fs::write(&sentinel, b"caller-owned").unwrap();
        let mut browser = SystemBrowser::new(root.path().to_path_buf());
        assert_eq!(browser.profile_root().unwrap(), root.path());
        drop(browser);
        assert_eq!(std::fs::read(sentinel).unwrap(), b"caller-owned");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn temporary_profile_cleanup_reaps_the_owned_child_before_removing_its_files() {
        let mut browser = SystemBrowser::temporary();
        let root = browser.profile_root().unwrap().to_path_buf();
        let child = Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        browser.process = Some(child);
        drop(browser);
        wait_until_removed(&root).await;
        let alive = Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .output()
            .await
            .unwrap();
        assert!(
            !alive.status.success(),
            "the owned child is reaped before its profile disappears"
        );
    }

    async fn wait_until_removed(path: &std::path::Path) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("owned temporary profile cleanup completes");
    }

    async fn mock(reply: Value) -> (Value, tokio::task::JoinHandle<Value>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let message = ws.next().await.unwrap().unwrap();
            let request: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            ws.send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"method":"Page.loadEventFired","params":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            ws.send(tokio_tungstenite::tungstenite::Message::Text(
                reply.to_string().into(),
            ))
            .await
            .unwrap();
            request
        });
        (
            json!({"webSocketDebuggerUrl":format!("ws://{address}/devtools/page/test")}),
            task,
        )
    }
    #[tokio::test]
    async fn an_explicit_missing_or_nonpage_tab_never_falls_back_or_sends_a_mutation() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4096];
                let n = socket.read(&mut bytes).await.unwrap();
                seen.lock().unwrap().push(
                    String::from_utf8_lossy(&bytes[..n])
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string(),
                );
                let body = json!([
                    {"id":"current","type":"page","url":"https://fixture.invalid/current","webSocketDebuggerUrl":format!("ws://{address}/mutation")},
                    {"id":"worker","type":"service_worker","url":"https://fixture.invalid/worker","webSocketDebuggerUrl":format!("ws://{address}/mutation")}
                ]).to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let mut browser = SystemBrowser::new(dir.path().into());
        browser.port = address.port();
        browser.tabs.insert(
            "owner".into(),
            ("current".into(), "https://fixture.invalid/current".into()),
        );
        for requested in ["cdp:closed", "closed", "", "cdp:worker"] {
            let error = browser
                .target("owner", false, Some(requested))
                .await
                .unwrap_err();
            assert!(error.contains("no longer available"), "{error}");
            assert_eq!(
                browser.tabs["owner"].0, "current",
                "a refusal must not replace the owner binding"
            );
        }
        // Omission still reuses a live owner binding; it is not an explicit stale target.
        assert_eq!(
            browser.target("owner", false, None).await.unwrap()["id"],
            "current"
        );
        assert_eq!(
            requests.lock().unwrap().as_slice(),
            ["GET /json/list HTTP/1.1"; 5]
        );
        server.abort();
    }

    #[tokio::test]
    async fn cdp_replies_are_correlated_and_events_are_not_results() {
        let (target, task) = mock(json!({"id":1,"result":{"result":{"value":"page text"}}})).await;
        assert_eq!(
            evaluate(&target, "document.title").await.unwrap(),
            "page text"
        );
        let request = task.await.unwrap();
        assert_eq!(request["method"], "Runtime.evaluate");
        assert_eq!(request["params"]["expression"], "document.title");
    }
    #[tokio::test]
    async fn protocol_errors_and_javascript_exceptions_reach_the_caller() {
        let (target, task) = mock(json!({"id":1,"error":{"message":"closed target"}})).await;
        assert_eq!(
            call(&target, "Page.reload", json!({})).await.unwrap_err(),
            "closed target"
        );
        task.await.unwrap();
        let (target, task) =
            mock(json!({"id":1,"result":{"exceptionDetails":{"text":"script failed"}}})).await;
        assert_eq!(
            evaluate(&target, "bad()").await.unwrap_err(),
            "script failed"
        );
        task.await.unwrap();
    }
}
