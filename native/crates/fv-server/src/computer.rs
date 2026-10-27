//! 电脑操控: the desktop-control driver (`cua-driver`), as this server sees it.
//!
//! The driver acts on the user's desktop, and macOS attributes Accessibility and Screen Recording
//! to the *application* that spawned the process that asks — not to an executable path. So the
//! server neither starts nor owns the driver: the application the user granted those permissions
//! to (the desktop GUI) spawns the daemon directly, and tells this server where it listens
//! (`computer/host`). All the server does is
//!
//! - fetch the executable once (`computer/install`): pinned version, pinned checksum, never
//!   executed unless it matches;
//! - run a stdio proxy to the host's daemon as a managed MCP server, so its tools reach the model
//!   like any other server's — deferred, because the driver's schemas are about 7 KB each and there
//!   are sixty of them.
//!
//! The version and checksums are the ones the Electron app pins; the two must move together.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fv_protocol::ErrorObject;
use fv_protocol::ServerNotification;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::{ComputerInstallProgress, ComputerStatus, McpServerConfig, McpTransport};
use sha2::{Digest, Sha256};

use crate::state::ServerState;

pub const VERSION: &str = "0.28.2";
const RELEASE: &str = "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2";
/// The same GitHub mirror the Electron app and the Agent runtime fall back to.
const MIRROR: &str = "https://gh-proxy.com/";
/// The id of the managed MCP server; its tools are `mcp_computer_<tool>`.
pub const SERVER_ID: &str = "computer";
/// No archive of this feature is larger than this once unpacked.
const MAX_EXECUTABLE_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub filename: &'static str,
    pub sha256: &'static str,
    /// The file to take out of the archive.
    pub member: &'static str,
    pub zip: bool,
}

/// The build for this OS and CPU, or why there is none.
///
/// Linux is not offered: the driver's Linux build needs compositor-specific helpers this app does
/// not ship (the same answer the Electron app gives).
pub fn artifact(os: &str, arch: &str) -> Result<Artifact, String> {
    match (os, arch) {
        ("macos", "aarch64" | "x86_64") => Ok(Artifact {
            filename: "cua-driver-rs-0.28.2-darwin-universal-binary.tar.gz",
            sha256: "386db225a3080714a0f9f935525e61efaf46709587ef8b94dd2df81aeb2f6daa",
            member: "cua-driver",
            zip: false,
        }),
        ("windows", "x86_64") => Ok(Artifact {
            filename: "cua-driver-rs-0.28.2-windows-x86_64-binary.zip",
            sha256: "1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba",
            member: "cua-driver.exe",
            zip: true,
        }),
        ("windows", "aarch64") => Ok(Artifact {
            filename: "cua-driver-rs-0.28.2-windows-arm64-binary.zip",
            sha256: "578b88ff2dd56f06eb7e984d73aaf5e76f59c6fde9542c967d6a30d00213c680",
            member: "cua-driver.exe",
            zip: true,
        }),
        ("linux", _) => Err("Linux 暂不支持电脑操控组件。".into()),
        (os, arch) => Err(format!("{os}/{arch} 没有电脑操控组件。")),
    }
}

/// Whether the basic `computer` tool (screencapture / osascript / xdotool / PowerShell) stays in
/// the model's tool set for this turn.
///
/// Off means no desktop tools at all. On, the driver's own tools replace it — except in the window
/// where the driver is not up (a download in flight, a daemon that died, permissions not granted
/// yet), and there the basic tool is the fallback. A platform with no driver build has no such
/// window, and its settings pane is hidden on the same reading
/// (`fv_protocol::types::computer_control_supported`, which `settings::section_available` filters
/// the navigation by): a switch nobody can reach must not leave behind a tool that only a
/// hand-edited settings file could turn on.
pub(crate) fn keep_basic_computer_tool(
    control_on: bool,
    driver_running: bool,
    supported: bool,
) -> bool {
    control_on && supported && !driver_running
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "cua-driver.exe"
    } else {
        "cua-driver"
    }
}

pub fn root(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime").join("cua-driver")
}

pub fn binary_path(data_dir: &Path) -> PathBuf {
    root(data_dir).join(executable_name())
}

/// The version recorded next to the executable by the install that put it there.
pub fn installed_version(data_dir: &Path) -> Option<String> {
    let version = std::fs::read_to_string(root(data_dir).join("VERSION")).ok()?;
    let version = version.trim();
    (binary_path(data_dir).is_file() && !version.is_empty()).then(|| version.to_string())
}

#[derive(Default)]
pub(crate) struct Computer {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    installing: bool,
    error: Option<String>,
    host: Option<String>,
}

impl Computer {
    fn status(&self, data_dir: &Path) -> ComputerStatus {
        let inner = self.inner.lock().unwrap();
        let (supported, unsupported_reason) =
            match artifact(std::env::consts::OS, std::env::consts::ARCH) {
                Ok(_) => (true, None),
                Err(reason) => (false, Some(reason)),
            };
        let version = installed_version(data_dir);
        let installed = version.as_deref() == Some(VERSION);
        ComputerStatus {
            binary: installed.then(|| binary_path(data_dir).display().to_string()),
            supported,
            unsupported_reason,
            // A different version than the one this build pins is not an install: the daemon
            // and the proxy must be the same release.
            installed,
            version,
            installing: inner.installing,
            running: inner.host.is_some(),
            error: inner.error.clone(),
        }
    }
}

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

fn failed(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, message)
}

/// The managed MCP server that proxies to the host's daemon.
pub fn server_config(binary: &Path, socket: &str) -> McpServerConfig {
    McpServerConfig {
        id: SERVER_ID.into(),
        name: "电脑操控".into(),
        transport: McpTransport::Stdio,
        enabled: true,
        command: Some(binary.display().to_string()),
        args: vec![
            "mcp".into(),
            "--embedded".into(),
            "--socket".into(),
            socket.into(),
        ],
        env: [
            // Only this exact value turns embedded mode on; anything else is ignored.
            ("CUA_DRIVER_EMBEDDED".to_string(), "1".to_string()),
            // The driver reports product telemetry unless told otherwise, and running it for the
            // user implies no consent to that.
            (
                "CUA_DRIVER_RS_TELEMETRY_ENABLED".to_string(),
                "0".to_string(),
            ),
        ]
        .into(),
        url: None,
        headers: Default::default(),
        deferred: true,
    }
}

impl ServerState {
    pub fn computer_status(&self) -> ComputerStatus {
        self.computer.status(&self.data_dir)
    }

    fn computer_changed(&self) {
        self.broadcast(ServerNotification::ComputerChanged(self.computer_status()));
    }

    /// The host application registers its daemon's socket, or withdraws it.
    pub fn computer_set_host(&self, socket: Option<String>) -> Result<(), ErrorObject> {
        let config = match &socket {
            Some(socket) => {
                if !Path::new(socket).is_absolute() || socket.contains('\0') {
                    return Err(invalid("the driver socket must be an absolute path"));
                }
                if !crate::settings::read(self)?.computer_control {
                    return Err(invalid("computer control is off"));
                }
                if installed_version(&self.data_dir).as_deref() != Some(VERSION) {
                    return Err(invalid("the computer-control component is not installed"));
                }
                Some(server_config(&binary_path(&self.data_dir), socket))
            }
            None => None,
        };
        self.computer.inner.lock().unwrap().host = socket;
        self.mcp.set_managed(config);
        self.computer_changed();
        Ok(())
    }

    /// Settings turned computer control off: nothing may keep reaching a daemon.
    pub(crate) fn computer_settings_changed(&self, enabled: bool) {
        if !enabled && self.computer.inner.lock().unwrap().host.take().is_some() {
            self.mcp.set_managed(None);
            self.computer_changed();
        }
    }

    pub async fn computer_install(
        self: &std::sync::Arc<Self>,
    ) -> Result<ComputerStatus, ErrorObject> {
        let artifact = artifact(std::env::consts::OS, std::env::consts::ARCH).map_err(invalid)?;
        {
            let mut inner = self.computer.inner.lock().unwrap();
            if inner.installing {
                return Err(invalid("an install is already running"));
            }
            inner.installing = true;
            inner.error = None;
        }
        self.computer_changed();
        let client = http_client(self)?;
        let state = self.clone();
        let result = install(
            &client,
            &self.data_dir,
            &artifact,
            &[
                format!("{RELEASE}/{}", artifact.filename),
                format!("{MIRROR}{RELEASE}/{}", artifact.filename),
            ],
            move |progress| {
                state.broadcast(ServerNotification::ComputerInstallProgress(progress));
            },
        )
        .await;
        {
            let mut inner = self.computer.inner.lock().unwrap();
            inner.installing = false;
            inner.error = result.as_ref().err().cloned();
        }
        self.computer_changed();
        result.map_err(failed)?;
        Ok(self.computer_status())
    }
}

fn http_client(state: &ServerState) -> Result<reqwest::Client, ErrorObject> {
    let settings = crate::settings::read(state)?;
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent("FastVibe-computer-install");
    if !settings.proxy_url.is_empty() {
        builder = builder.proxy(
            reqwest::Proxy::all(&settings.proxy_url).map_err(|_| invalid("invalid proxy URL"))?,
        );
    }
    builder.build().map_err(|e| failed(e.to_string()))
}

/// Download, verify, unpack and put the executable in place.
///
/// The old executable stays until the new one has been verified and extracted next to it, so a
/// failure leaves whatever worked before.
pub(crate) async fn install(
    client: &reqwest::Client,
    data_dir: &Path,
    artifact: &Artifact,
    urls: &[String],
    progress: impl Fn(ComputerInstallProgress) + Send + Sync + 'static,
) -> Result<(), String> {
    let root = root(data_dir);
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|e| e.to_string())?;
    let archive = root.join(format!(".partial-{}", artifact.filename));
    let result = async {
        download_verified(client, urls, &archive, artifact.sha256, &progress).await?;
        let (archive_path, artifact) = (archive.clone(), artifact.clone());
        let staged = root.join(format!(".new-{}", executable_name()));
        let staged_for_task = staged.clone();
        tokio::task::spawn_blocking(move || extract(&archive_path, &artifact, &staged_for_task))
            .await
            .map_err(|e| e.to_string())??;
        let target = root.join(executable_name());
        tokio::fs::rename(&staged, &target)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::write(root.join("VERSION"), VERSION)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_file(&archive).await;
    let _ = tokio::fs::remove_file(root.join(format!(".new-{}", executable_name()))).await;
    result
}

/// The first URL that answers and matches the pinned checksum. A transfer that goes quiet is
/// abandoned so the mirror can be tried instead of waiting out a blocked host.
async fn download_verified(
    client: &reqwest::Client,
    urls: &[String],
    dest: &Path,
    sha256: &str,
    progress: &(impl Fn(ComputerInstallProgress) + Send + Sync),
) -> Result<(), String> {
    let mut last = "download failed".to_string();
    for (index, url) in urls.iter().enumerate() {
        let stall = Duration::from_secs(if index == 0 { 20 } else { 60 });
        match download_one(client, url, dest, stall, progress).await {
            Ok(actual) if actual == sha256 => return Ok(()),
            Ok(_) => {
                let _ = tokio::fs::remove_file(dest).await;
                last = "checksum mismatch".into();
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(dest).await;
                last = error;
            }
        }
    }
    Err(last)
}

async fn download_one(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    stall: Duration,
    progress: &(impl Fn(ComputerInstallProgress) + Send + Sync),
) -> Result<String, String> {
    use tokio::io::AsyncWriteExt as _;
    let mut response = tokio::time::timeout(stall, client.get(url).send())
        .await
        .map_err(|_| "the download did not start".to_string())?
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let total = response.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_report = Instant::now() - Duration::from_secs(1);
    loop {
        let chunk = tokio::time::timeout(stall, response.chunk())
            .await
            .map_err(|_| "the download stalled".to_string())?
            .map_err(|e| e.to_string())?;
        let Some(chunk) = chunk else { break };
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if last_report.elapsed() >= Duration::from_millis(250) {
            last_report = Instant::now();
            progress(ComputerInstallProgress { received, total });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    progress(ComputerInstallProgress {
        received,
        total: received,
    });
    Ok(format!("{:x}", hasher.finalize()))
}

/// Take the one executable out of the archive. Nothing else is written, and no path inside the
/// archive is ever used to name a file on disk.
pub(crate) fn extract(archive: &Path, artifact: &Artifact, dest: &Path) -> Result<(), String> {
    use std::io::{Read as _, Write as _};
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let copied = if artifact.zip {
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let mut found = None;
        for i in 0..zip.len() {
            let entry = zip.by_index(i).map_err(|e| e.to_string())?;
            if entry.is_file() && entry.name().rsplit('/').next() == Some(artifact.member) {
                found = Some(i);
                break;
            }
        }
        let index = found.ok_or_else(|| format!("{} is not in the archive", artifact.member))?;
        let entry = zip.by_index(index).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry.take(MAX_EXECUTABLE_BYTES + 1), &mut out)
            .map_err(|e| e.to_string())?
    } else {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        let mut copied = None;
        for entry in tar.entries().map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let matches = entry
                .path()
                .map_err(|e| e.to_string())?
                .file_name()
                .is_some_and(|name| name == artifact.member);
            if matches {
                copied = Some(
                    std::io::copy(&mut entry.take(MAX_EXECUTABLE_BYTES + 1), &mut out)
                        .map_err(|e| e.to_string())?,
                );
                break;
            }
        }
        copied.ok_or_else(|| format!("{} is not in the archive", artifact.member))?
    };
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if copied == 0 || copied > MAX_EXECUTABLE_BYTES {
        let _ = std::fs::remove_file(dest);
        return Err("the extracted executable has an implausible size".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_basic_tool_follows_the_switch_the_driver_and_the_platform() {
        // Off: no desktop tools at all, whatever the platform.
        assert!(!keep_basic_computer_tool(false, false, true));
        // On with the driver up: its own tools replace the basic one.
        assert!(!keep_basic_computer_tool(true, true, true));
        // On while the driver is not up yet: the basic tool is the fallback.
        assert!(keep_basic_computer_tool(true, false, true));
        // A platform with no driver build has no fallback, and no pane to switch it on.
        assert!(!keep_basic_computer_tool(true, false, false));
    }

    #[test]
    fn every_os_with_a_build_shows_the_pane() {
        // The settings navigation hides the pane where `computer_control_supported` is false, so an
        // OS that does have a build must never be one of those. The other direction may differ: a
        // 32-bit Windows keeps its pane and reads the unsupported reason in it, because the shared
        // answer is per OS while `artifact` is per OS and CPU.
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("windows", "x86_64"),
            ("windows", "aarch64"),
        ] {
            assert!(artifact(os, arch).is_ok(), "{os}/{arch}");
            assert!(
                fv_protocol::types::computer_control_supported(os),
                "{os} has a build but no pane"
            );
        }
        // And the platform that hides the pane has no build, and so no fallback tool.
        assert!(!fv_protocol::types::computer_control_supported("linux"));
        assert!(artifact("linux", "x86_64").is_err());
    }

    #[test]
    fn only_macos_and_windows_have_a_build() {
        assert!(artifact("macos", "aarch64").is_ok());
        assert_eq!(
            artifact("macos", "x86_64").unwrap().filename,
            artifact("macos", "aarch64").unwrap().filename,
            "one universal binary serves both CPUs"
        );
        assert!(artifact("windows", "x86_64").unwrap().zip);
        assert!(artifact("windows", "aarch64").is_ok());
        assert!(artifact("linux", "x86_64").is_err());
        assert!(artifact("freebsd", "x86_64").is_err());
    }

    #[test]
    fn every_pinned_checksum_is_a_sha256() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("windows", "x86_64"),
            ("windows", "aarch64"),
        ] {
            let a = artifact(os, arch).unwrap();
            assert_eq!(a.sha256.len(), 64, "{}", a.filename);
            assert!(a.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
            assert!(
                a.filename.contains(VERSION),
                "{} names another version",
                a.filename
            );
        }
    }

    #[test]
    fn the_managed_server_proxies_to_the_hosts_socket_with_telemetry_off() {
        let config = server_config(Path::new("/d/cua-driver"), "/d/s.sock");
        assert_eq!(config.id, SERVER_ID);
        assert_eq!(config.command.as_deref(), Some("/d/cua-driver"));
        assert_eq!(config.args, ["mcp", "--embedded", "--socket", "/d/s.sock"]);
        assert_eq!(config.env["CUA_DRIVER_EMBEDDED"], "1");
        assert_eq!(config.env["CUA_DRIVER_RS_TELEMETRY_ENABLED"], "0");
        assert!(
            config.deferred,
            "sixty tool schemas must not ride on every request"
        );
    }
}

#[cfg(test)]
mod install_tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn tar_gz(member: &str, body: &[u8]) -> Vec<u8> {
        let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);
        for (path, data) in [("pack/README.md", &b"not the driver"[..]), (member, body)] {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, path, data).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }

    fn zip_of(member: &str, body: &[u8]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut out);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("readme.txt", options).unwrap();
        zip.write_all(b"not the driver").unwrap();
        zip.start_file(member, options).unwrap();
        zip.write_all(body).unwrap();
        zip.finish().unwrap();
        out.into_inner()
    }

    fn artifact_for(bytes: &[u8], member: &'static str, zip: bool) -> Artifact {
        Artifact {
            filename: "driver.pkg",
            sha256: Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str()),
            member,
            zip,
        }
    }

    /// Serve `bodies[i]` to the i-th connection, then stop.
    async fn serve(bodies: Vec<Vec<u8>>) -> (String, Arc<AtomicUsize>) {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            for body in bodies {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut request = [0u8; 2048];
                let _ = socket.read(&mut request).await;
                counter.fetch_add(1, Ordering::SeqCst);
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&body).await;
            }
        });
        (base, hits)
    }

    #[tokio::test]
    async fn a_bad_checksum_falls_through_to_the_mirror_and_the_good_one_installs() {
        let driver = b"#!/bin/sh\necho driver\n";
        let good = tar_gz("pack/bin/cua-driver", driver);
        let artifact = artifact_for(&good, "cua-driver", false);
        let (base, hits) = serve(vec![b"tampered".to_vec(), good]).await;
        let dir = tempfile::tempdir().unwrap();
        let progress = Arc::new(Mutex::new(Vec::new()));
        let seen = progress.clone();
        install(
            &reqwest::Client::new(),
            dir.path(),
            &artifact,
            &[format!("{base}/official"), format!("{base}/mirror")],
            move |p| seen.lock().unwrap().push(p),
        )
        .await
        .unwrap();
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "the first answer was refused, the second used"
        );
        let target = root(dir.path()).join(executable_name());
        assert_eq!(std::fs::read(&target).unwrap(), driver);
        assert_eq!(
            std::fs::read_to_string(root(dir.path()).join("VERSION")).unwrap(),
            VERSION
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o111,
                0o111
            );
        }
        assert!(
            progress
                .lock()
                .unwrap()
                .last()
                .is_some_and(|p| p.received > 0)
        );
        let leftovers: Vec<_> = std::fs::read_dir(root(dir.path()))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with('.'))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no partial files stay behind: {leftovers:?}"
        );
    }

    #[tokio::test]
    async fn nothing_that_fails_verification_is_installed_or_replaces_a_working_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root(dir.path())).unwrap();
        std::fs::write(
            root(dir.path()).join(executable_name()),
            b"old working driver",
        )
        .unwrap();
        let artifact = artifact_for(b"the real archive", "cua-driver", false);
        let (base, _) = serve(vec![b"wrong".to_vec(), b"also wrong".to_vec()]).await;
        let error = install(
            &reqwest::Client::new(),
            dir.path(),
            &artifact,
            &[format!("{base}/a"), format!("{base}/b")],
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(error.contains("checksum"), "{error}");
        assert_eq!(
            std::fs::read(root(dir.path()).join(executable_name())).unwrap(),
            b"old working driver"
        );
    }

    #[test]
    fn an_archive_without_the_executable_is_refused_and_a_zip_is_read_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.zip");
        std::fs::write(&archive, zip_of("nested/cua-driver.exe", b"MZ driver")).unwrap();
        let ok = Artifact {
            filename: "a.zip",
            sha256: "",
            member: "cua-driver.exe",
            zip: true,
        };
        let dest = dir.path().join("out");
        extract(&archive, &ok, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"MZ driver");

        let missing = Artifact {
            member: "other.exe",
            ..ok
        };
        assert!(
            extract(&archive, &missing, &dir.path().join("out2"))
                .unwrap_err()
                .contains("not in the archive")
        );

        let empty = dir.path().join("e.tar.gz");
        std::fs::write(&empty, tar_gz("pack/cua-driver", b"")).unwrap();
        let zero = Artifact {
            filename: "e",
            sha256: "",
            member: "cua-driver",
            zip: false,
        };
        assert!(
            extract(&empty, &zero, &dir.path().join("out3"))
                .unwrap_err()
                .contains("implausible")
        );
        assert!(
            !dir.path().join("out3").exists(),
            "an empty executable is not left behind"
        );
    }
}
