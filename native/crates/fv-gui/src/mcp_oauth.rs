//! The GUI's OAuth callback belongs on the GUI's machine, even when its backend is remote.
//! Server RPCs carry only the authorization URL and callback; tokens never cross the bridge.

use std::sync::Arc;
use std::time::Duration;

use fv_client::Client;
use fv_protocol::methods::{McpAuthBegin, McpAuthCancel, McpAuthComplete};
use fv_protocol::types::{
    McpAuthBeginParams, McpAuthCancelParams, McpAuthCompleteParams, McpListResponse,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch};

use super::Backend;

pub(crate) struct OAuthCancellation(watch::Sender<bool>);

impl Drop for OAuthCancellation {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

impl Backend {
    pub(crate) fn start_mcp_oauth(
        &self,
        server_id: String,
        client_id: Option<String>,
        client_secret: Option<String>,
        scopes: Vec<String>,
    ) -> (
        OAuthCancellation,
        oneshot::Receiver<String>,
        impl Future<Output = Result<McpListResponse, String>> + Send + 'static,
    ) {
        let (cancel, mut canceled) = watch::channel(false);
        let (send_url, url) = oneshot::channel();
        let client = self.client.clone();
        let task = self.runtime.spawn(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("无法接收登录回调：{e}"))?;
            let origin = format!("http://{}", listener.local_addr().map_err(|e| e.to_string())?);
            let redirect_uri = format!("{origin}/mcp/oauth/callback");
            // If canceled while the server discovers OAuth, retain the request until its bounded
            // answer arrives so the returned flow id can be canceled instead of orphaned.
            let begin = tokio::time::timeout(Duration::from_secs(65), client.call::<McpAuthBegin>(McpAuthBeginParams {
                server_id, redirect_uri: redirect_uri.clone(), client_id, client_secret, scopes,
            })).await.map_err(|_| "准备登录超时".to_string())?.map_err(|e| e.to_string())?;
            let flow_id = begin.flow_id;
            let work = async {
                if *canceled.borrow() { return Err("登录已取消".into()); }
                // The server's discovered URL is still untrusted at the desktop boundary.
                let authorization = url::Url::parse(&begin.authorization_url).map_err(|_| "授权地址无效")?;
                if !matches!(authorization.scheme(), "https" | "http") || authorization.host_str().is_none()
                    || !authorization.username().is_empty() || authorization.password().is_some() {
                    return Err("授权地址无效".into());
                }
                let expected_state = authorization.query_pairs().find(|(key, _)| key == "state")
                    .map(|(_, value)| value.to_string()).ok_or("授权地址缺少 state")?;
                if send_url.send(begin.authorization_url).is_err() { return Err("登录窗口已关闭".into()); }
                tokio::select! {
                    biased;
                    _ = canceled.changed() => Err("登录已取消".into()),
                    result = tokio::time::timeout(Duration::from_secs(600), receive_callback(listener, &origin, &redirect_uri, client.clone(), &flow_id, &expected_state)) => {
                        result.map_err(|_| "登录已过期，请重试".to_string())?
                    }
                }
            }.await;
            let _ = tokio::time::timeout(Duration::from_secs(5), client.call::<McpAuthCancel>(McpAuthCancelParams { flow_id })).await;
            work
        });
        (OAuthCancellation(cancel), url, async move {
            task.await.map_err(|_| "登录已结束".to_string())?
        })
    }
}

async fn receive_callback(
    listener: TcpListener,
    origin: &str,
    redirect: &str,
    client: Arc<Client>,
    flow: &str,
    expected_state: &str,
) -> Result<McpListResponse, String> {
    loop {
        let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let request =
            match tokio::time::timeout(Duration::from_secs(5), read_request(&mut socket)).await {
                Ok(Ok(request)) => request,
                _ => continue,
            };
        let first = request.lines().next().unwrap_or("");
        let mut parts = first.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("");
        let host_ok = request
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .any(|(key, value)| {
                key.eq_ignore_ascii_case("host")
                    && value.trim() == origin.trim_start_matches("http://")
            });
        if method != "GET" || !host_ok || !target.starts_with("/mcp/oauth/callback?") {
            respond(&mut socket, 404, "Not found").await;
            continue;
        }
        // Validate the browser's state before the RPC so a stray local request cannot
        // consume the listener. The server also validates the redirect, state and issuer.
        let callback_url = format!("{origin}{target}");
        let callback = match url::Url::parse(&callback_url) {
            Ok(url) => url,
            Err(_) => {
                respond(&mut socket, 400, "Invalid callback").await;
                continue;
            }
        };
        let states: Vec<_> = callback
            .query_pairs()
            .filter(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string())
            .collect();
        if states.as_slice() != [expected_state] {
            respond(&mut socket, 400, "Invalid state").await;
            continue;
        }
        if !callback_url.starts_with(&format!("{redirect}?")) {
            continue;
        }
        let result = client
            .call::<McpAuthComplete>(McpAuthCompleteParams {
                flow_id: flow.into(),
                callback_url,
            })
            .await;
        match result {
            Ok(result) => {
                respond(&mut socket, 200, "登录完成，可以返回 FastVibe。").await;
                return Ok(result);
            }
            Err(error) => {
                respond(&mut socket, 400, "未能完成登录，请查看 FastVibe 中的说明。").await;
                // A forged state gets no details here; surface the server error in the app.
                return Err(error.to_string());
            }
        }
    }
}

async fn read_request(socket: &mut TcpStream) -> std::io::Result<String> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 1024];
    while bytes.len() < 16 * 1024 {
        let n = socket.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..n]);
        if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            return String::from_utf8(bytes).map_err(std::io::Error::other);
        }
    }
    Err(std::io::Error::other(
        "callback request is incomplete or too large",
    ))
}

async fn respond(socket: &mut TcpStream, status: u16, message: &str) {
    let response = format!(
        "HTTP/1.1 {status} Response\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{message}",
        message.len()
    );
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        socket.write_all(response.as_bytes()),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, BufReader};

    async fn http(address: &str, host: &str, query: &str) -> String {
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket
            .write_all(
                format!("GET /mcp/oauth/callback?{query} HTTP/1.1\r\nHost: {host}\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut bytes = Vec::new();
        socket.read_to_end(&mut bytes).await.unwrap();
        String::from_utf8(bytes).unwrap()
    }

    #[tokio::test]
    async fn unrelated_local_requests_cannot_consume_the_legitimate_browser_callback() {
        let (local, remote) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(local);
        let (client, _) = Client::from_io(read, write);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let origin = format!("http://{address}");
        let redirect = format!("{origin}/mcp/oauth/callback");
        let task = tokio::spawn(async move {
            receive_callback(
                listener,
                &origin,
                &redirect,
                Arc::new(client),
                "this-flow",
                "expected-state",
            )
            .await
        });
        assert!(
            http(&address, &address, "state=forged&code=abc")
                .await
                .starts_with("HTTP/1.1 400")
        );
        assert!(
            http(&address, "wrong-host", "state=expected-state&code=abc")
                .await
                .starts_with("HTTP/1.1 404")
        );
        assert!(!task.is_finished());
        let peer = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(remote);
            let line = BufReader::new(read)
                .lines()
                .next_line()
                .await
                .unwrap()
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "mcp/auth/complete");
            assert_eq!(request["params"]["flowId"], "this-flow");
            assert!(
                request["params"]["callbackUrl"]
                    .as_str()
                    .unwrap()
                    .contains("state=expected-state")
            );
            write
                .write_all(
                    format!("{}\n", json!({"id":request["id"],"result":{"servers":[]}})).as_bytes(),
                )
                .await
                .unwrap();
        });
        assert!(
            http(&address, &address, "state=expected-state&code=abc")
                .await
                .starts_with("HTTP/1.1 200")
        );
        assert!(task.await.unwrap().unwrap().servers.is_empty());
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn closing_the_login_cancels_the_remote_flow_and_releases_the_local_listener() {
        let (local, remote) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(local);
        let (client, _) = Client::from_io(read, write);
        let backend = Backend {
            client: Arc::new(client),
            runtime: tokio::runtime::Handle::current(),
        };
        let (send_redirect, redirect) = oneshot::channel();
        let peer = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(remote);
            let mut lines = BufReader::new(read).lines();
            let request: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(request["method"], "mcp/auth/begin");
            send_redirect
                .send(
                    request["params"]["redirectUri"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                )
                .unwrap();
            write.write_all(format!("{}\n", json!({"id":request["id"],"result":{"flowId":"flow-to-cancel","authorizationUrl":"https://auth.example/authorize?state=fixture-state"}})).as_bytes()).await.unwrap();
            let request: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(request["method"], "mcp/auth/cancel");
            assert_eq!(request["params"]["flowId"], "flow-to-cancel");
            write
                .write_all(format!("{}\n", json!({"id":request["id"],"result":{}})).as_bytes())
                .await
                .unwrap();
        });
        let (cancel, url, complete) = backend.start_mcp_oauth("server".into(), None, None, vec![]);
        assert!(url.await.unwrap().starts_with("https://auth.example/"));
        let redirect = url::Url::parse(&redirect.await.unwrap()).unwrap();
        drop(cancel);
        assert!(complete.await.unwrap_err().contains("取消"));
        let address = format!(
            "{}:{}",
            redirect.host_str().unwrap(),
            redirect.port().unwrap()
        );
        assert!(TcpStream::connect(address).await.is_err());
        peer.await.unwrap();
    }
}
