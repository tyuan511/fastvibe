use crate::{Cookie, engines};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tokio::process::{Child, Command};

pub struct SystemBrowser {
    root: PathBuf,
    process: Option<Child>,
    engine: String,
    port: u16,
    tabs: HashMap<String, (String, String)>,
    client: reqwest::Client,
}
impl SystemBrowser {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            process: None,
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
        let profile = self.root.join(engine.id);
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
        if !new_tab
            && let Some(id) = requested.map(|v| v.strip_prefix("cdp:").unwrap_or(v))
            && let Some(target) = targets.iter().find(|t| t["id"].as_str() == Some(id))
        {
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
            return Ok(serde_json::to_string(&tabs).map_err(|e| e.to_string())?);
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
