//! SSH host configuration and explicit installation. Nothing mutates the user's ssh_config.
use fv_client::Client;
use fv_protocol::ServerNotification;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedReceiver;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshHost {
    /// Hostname or an existing ssh_config alias; never interpreted by a local shell.
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<PathBuf>,
    pub server_binary: String,
    pub data_dir: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshTarget {
    pub os: String,
    pub arch: String,
}

impl SshHost {
    /// Read the target identity without installing or starting a server.
    pub async fn probe(&self) -> Result<SshTarget, String> {
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(25),
            self.command()
                .map_err(|e| e.to_string())?
                .arg("uname -s; uname -m")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| "SSH test timed out".to_string())?
        .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(4096)
                .collect());
        }
        let platform = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
        let mut lines = platform.lines();
        let target = SshTarget {
            os: lines.next().unwrap_or_default().into(),
            arch: lines.next().unwrap_or_default().into(),
        };
        if !matches!(target.os.as_str(), "Darwin" | "Linux")
            || !matches!(target.arch.as_str(), "arm64" | "aarch64" | "x86_64")
        {
            return Err(format!(
                "Unsupported SSH target: {} {} (supported: Linux/macOS, arm64/x86_64)",
                target.os, target.arch
            ));
        }
        Ok(target)
    }

    /// Complete the same native handshake used by the local GUI. SSH profiles never carry
    /// App Server tokens: the authenticated OpenSSH channel is the transport boundary.
    pub async fn connect_current(
        &self,
        client_name: &str,
        client_version: &str,
        required_features: &[&str],
    ) -> Result<crate::Connection, String> {
        use fv_protocol::methods::Initialize;
        use fv_protocol::types::{ClientCapabilities, ClientInfo, InitializeParams};
        let (client, notifications) = self.connect().await?;
        let requests = client
            .take_requests()
            .ok_or("SSH client request receiver unavailable")?;
        let hello = tokio::time::timeout(std::time::Duration::from_secs(25),
            client.call::<Initialize>(InitializeParams {
                client_info: ClientInfo { name: client_name.into(), version: client_version.into() },
                protocol_version: fv_protocol::PROTOCOL_VERSION,
                capabilities: ClientCapabilities::default(),
            }))
            .await.map_err(|_| "SSH server handshake timed out; test the host and install a matching native server".to_string())?
            .map_err(|e| format!("SSH server handshake failed: {e}; test the host and verify the installed native server"))?;
        let missing: Vec<_> = required_features
            .iter()
            .filter(|f| !hello.features.iter().any(|present| present == **f))
            .copied()
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "SSH server lacks required features: {}. Install the matching native server build.",
                missing.join(", ")
            ));
        }
        if hello.protocol_version != fv_protocol::PROTOCOL_VERSION {
            return Err(
                "SSH server protocol version is incompatible; install the matching native server"
                    .into(),
            );
        }
        let version_mismatch = hello.server_version != client_version;
        Ok(crate::Connection {
            client,
            notifications,
            requests,
            server_version: hello.server_version,
            features: hello.features,
            version_mismatch,
            has_running_turns: hello.has_running_turns,
        })
    }

    fn validate(&self) -> std::io::Result<()> {
        for value in [Some(self.host.as_str()), self.user.as_deref()]
            .into_iter()
            .flatten()
        {
            if value.is_empty()
                || value.starts_with('-')
                || value.chars().any(|c| c.is_control() || c.is_whitespace())
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "invalid SSH host/user",
                ));
            }
        }
        if [self.server_binary.as_str(), self.data_dir.as_str()]
            .iter()
            .any(|path| !path.starts_with('/') || path.chars().any(char::is_control))
            || self.port == Some(0)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "SSH server paths must be absolute and control-free",
            ));
        }
        Ok(())
    }
    fn command(&self) -> std::io::Result<Command> {
        self.validate()?;
        let mut command = Command::new("ssh");
        command.args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=15",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
        ]);
        if let Some(port) = self.port {
            command.args(["-p", &port.to_string()]);
        }
        if let Some(identity) = &self.identity_file {
            command.arg("-i").arg(identity);
        }
        let host = self
            .user
            .as_ref()
            .map_or_else(|| self.host.clone(), |user| format!("{user}@{}", self.host));
        command.arg("--").arg(host);
        Ok(command)
    }
    /// Start/reach the resident server and relay native JSON frames. Dropping this client kills
    /// only the SSH relay; the daemon and its running turns retain their process group.
    pub async fn connect(&self) -> Result<(Client, UnboundedReceiver<ServerNotification>), String> {
        let mut command = self.command().map_err(|error| error.to_string())?;
        command
            .arg(format!(
                "{} --data-dir {} --listen relay",
                quote(&self.server_binary),
                quote(&self.data_dir)
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let input = child.stdin.take().ok_or("SSH stdin unavailable")?;
        let output = child.stdout.take().ok_or("SSH stdout unavailable")?;
        let (client, notes) = Client::from_io(output, input);
        // Child is reaped after the pipe closes. The remote process is a relay, not the daemon.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        Ok((client, notes))
    }
    /// Explicit install foundation: copy the selected binary over SSH stdin, chmod and atomic
    /// rename. Callers must select a binary built for the remote architecture first.
    pub async fn install(
        &self,
        binary: &Path,
        expected_os: &str,
        expected_arch: &str,
    ) -> Result<(), String> {
        use sha2::{Digest, Sha256};
        let output = self
            .command()
            .map_err(|error| error.to_string())?
            .arg("uname -s; uname -m")
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| error.to_string())?;
        let platform = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
        let mut lines = platform.lines();
        if !output.status.success()
            || lines.next() != Some(expected_os)
            || lines.next() != Some(expected_arch)
        {
            return Err("SSH target OS/architecture does not match selected binary".into());
        }
        let bytes = tokio::fs::read(binary)
            .await
            .map_err(|error| error.to_string())?;
        let checksum = format!("{:x}", Sha256::digest(&bytes));
        let mut source = std::io::Cursor::new(bytes);
        let target = &self.server_binary;
        let temporary = format!(
            "{target}.install-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos()
        );
        let parent = Path::new(target)
            .parent()
            .and_then(Path::to_str)
            .ok_or("server path needs a parent")?;
        let cleanup = quote(&format!("rm -f -- {}", quote(&temporary)));
        let script = format!(
            "set -eu; umask 077; mkdir -p {}; trap {} EXIT; cat > {}; if command -v sha256sum >/dev/null 2>&1; then sum=$(sha256sum {}); else sum=$(shasum -a 256 {}); fi; test \"${{sum%% *}}\" = {}; chmod 700 {}; identity=$({} --version); case \"$identity\" in 'fastvibe-server '*) ;; *) exit 65 ;; esac; mv -f {} {}; trap - EXIT",
            quote(parent),
            cleanup,
            quote(&temporary),
            quote(&temporary),
            quote(&temporary),
            quote(&checksum),
            quote(&temporary),
            quote(&temporary),
            quote(&temporary),
            quote(target)
        );
        let mut command = self.command().map_err(|error| error.to_string())?;
        let mut child = command
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| error.to_string())?;
        let mut input = child.stdin.take().ok_or("SSH stdin unavailable")?;
        tokio::io::copy(&mut source, &mut input)
            .await
            .map_err(|error| error.to_string())?;
        drop(input);
        let output = child
            .wait_with_output()
            .await
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(4096)
                .collect())
        }
    }
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_arguments_are_shell_quoted() {
        assert_eq!(quote("a'$(touch x)"), "'a'\\''$(touch x)'");
        let host = SshHost {
            host: "-oProxyCommand=bad".into(),
            user: None,
            port: None,
            identity_file: None,
            server_binary: "/tmp/server".into(),
            data_dir: "/tmp/data".into(),
        };
        assert!(host.command().is_err());
    }
}
