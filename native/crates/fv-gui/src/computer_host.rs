//! 电脑操控, host side: this application owns the desktop driver's daemon.
//!
//! macOS attributes Accessibility and Screen Recording to the *application* at the top of a
//! process's launch chain, not to an executable path. A daemon the server (or a shell, or
//! `open`) started would own none of the grants the user gave FastVibe, so the app that holds
//! them spawns it directly — `posix_spawn`, never through LaunchServices — and the driver, told it
//! is embedded, stays in this app's responsibility chain instead of claiming an identity of its
//! own. The server only learns where the daemon listens (`computer/host`).
//!
//! The daemon cannot outlive us: it watches a pipe we hold on its stdin, and [`Host`] also stops
//! it on drop.

use std::io::Read as _;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a freshly spawned daemon has to start accepting connections.
const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// The tail of the daemon's stderr kept for a failure message.
const STDERR_KEEP: usize = 8 * 1024;

pub struct Host {
    child: Child,
    endpoint: String,
    stderr: Arc<Mutex<String>>,
}

/// Where the daemon listens. A unix socket in the temp directory (a socket path is limited to ~100
/// bytes, which the data directory under `~/Library/Application Support` can exceed), a named pipe
/// on Windows. Unique per process so two running copies cannot share one.
pub fn endpoint() -> String {
    let pid = std::process::id();
    if cfg!(windows) {
        format!(r"\\.\pipe\fastvibe-cua-{pid}")
    } else {
        std::env::temp_dir()
            .join(format!("fastvibe-cua-{pid}.sock"))
            .display()
            .to_string()
    }
}

impl Host {
    /// Start `binary serve --embedded` on `endpoint` and wait until it accepts connections.
    ///
    /// Blocking (up to [`READY_TIMEOUT`]): run it off the UI thread.
    pub fn start(binary: &Path, endpoint: &str, bundle_id: &str) -> Result<Host, String> {
        if !binary.is_file() {
            return Err(format!("找不到电脑操控组件：{}", binary.display()));
        }
        if !cfg!(windows) {
            let _ = std::fs::remove_file(endpoint);
        }
        let mut command = Command::new(binary);
        command
            .args(["serve", "--embedded", "--socket", endpoint])
            // Only this exact value turns embedded mode on; anything else is ignored.
            .env("CUA_DRIVER_EMBEDDED", "1")
            .env("CUA_DRIVER_HOST_BUNDLE_ID", bundle_id)
            .env("CUA_DRIVER_PARENT_LIVENESS_STDIN", "1")
            // The driver reports product telemetry unless told otherwise, and running it for
            // the user implies no consent to that.
            .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0")
            // The driver's default, stated: promptless routine automation with the host owning
            // the permission experience. Nothing here widens it.
            .env("CUA_DRIVER_PERMISSION_MODE", "standard")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动电脑操控组件：{e}"))?;
        let stderr = Arc::new(Mutex::new(String::new()));
        if let Some(mut pipe) = child.stderr.take() {
            let keep = stderr.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 2048];
                while let Ok(n) = pipe.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut text = keep.lock().unwrap();
                    text.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if text.len() > STDERR_KEEP {
                        let mut cut = text.len() - STDERR_KEEP;
                        while !text.is_char_boundary(cut) {
                            cut += 1;
                        }
                        text.drain(..cut);
                    }
                }
            });
        }
        let mut host = Host {
            child,
            endpoint: endpoint.to_string(),
            stderr,
        };
        host.wait_ready(READY_TIMEOUT)?;
        Ok(host)
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Whether the daemon is still running.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn wait_ready(&mut self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                let said = self.stderr.lock().unwrap().trim().to_string();
                return Err(if said.is_empty() {
                    format!("电脑操控组件启动后退出了（{status}）")
                } else {
                    format!("电脑操控组件启动后退出了：{said}")
                });
            }
            if connectable(&self.endpoint) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                self.stop();
                return Err("电脑操控组件没有在预期时间内就绪".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Close the liveness pipe (an orderly exit), then end the process if it does not leave.
    pub fn stop(&mut self) {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if !cfg!(windows) {
            let _ = std::fs::remove_file(&self.endpoint);
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(unix)]
fn connectable(endpoint: &str) -> bool {
    std::os::unix::net::UnixStream::connect(endpoint).is_ok()
}

#[cfg(windows)]
fn connectable(endpoint: &str) -> bool {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(endpoint)
        .is_ok()
}

#[cfg(not(any(unix, windows)))]
fn connectable(_: &str) -> bool {
    false
}

/// What the OS has granted this application. Only macOS gates desktop control behind permissions
/// the application itself must hold; elsewhere there is nothing to grant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Permissions {
    pub accessibility: bool,
    pub screen_recording: bool,
}

impl Permissions {
    pub fn ready(self) -> bool {
        self.accessibility && self.screen_recording
    }
}

/// Whether this OS has a permission model for desktop control that the host must satisfy.
pub const GATED: bool = cfg!(target_os = "macos");

/// A read that never prompts.
pub fn permissions() -> Permissions {
    #[cfg(target_os = "macos")]
    {
        mac::status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Permissions {
            accessibility: true,
            screen_recording: true,
        }
    }
}

/// Ask macOS to list this application under Privacy & Security and raise its prompts. Granting
/// stays the user's decision; this only makes the toggle exist.
pub fn request_permissions() {
    #[cfg(target_os = "macos")]
    mac::request();
}

/// The Privacy & Security pane to send the user to for a permission.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pane {
    Accessibility,
    ScreenRecording,
}

pub fn open_settings(pane: Pane) {
    #[cfg(target_os = "macos")]
    {
        let anchor = match pane {
            Pane::Accessibility => "Privacy_Accessibility",
            Pane::ScreenRecording => "Privacy_ScreenCapture",
        };
        let _ = Command::new("open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{anchor}"
            ))
            .spawn();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pane;
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Permissions;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::CFString;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn status() -> Permissions {
        // SAFETY: both are plain queries with no arguments and no side effects.
        unsafe {
            Permissions {
                accessibility: AXIsProcessTrusted(),
                screen_recording: CGPreflightScreenCaptureAccess(),
            }
        }
    }

    pub fn request() {
        let key = CFString::new("AXTrustedCheckOptionPrompt");
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        // SAFETY: `options` is a valid CFDictionary that lives through the call.
        unsafe {
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
            CGRequestScreenCaptureAccess();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    /// A "driver" that records how it was started, listens on the socket it was given, and exits
    /// when its stdin closes — the contract the real daemon keeps.
    fn fake(dir: &Path, body: &str) -> std::path::PathBuf {
        let path = dir.join("cua-driver");
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn serving(log: &Path) -> String {
        format!(
            "#!/usr/bin/env python3\nimport os, socket, sys\n\
             open({log:?}, 'w').write(repr(sys.argv[1:]) + '\\n' + '\\n'.join(f'{{k}}={{v}}' for k, v in sorted(os.environ.items()) if k.startswith('CUA_')))\n\
             path = sys.argv[sys.argv.index('--socket') + 1]\n\
             s = socket.socket(socket.AF_UNIX); s.bind(path); s.listen(4)\n\
             sys.stdin.read()\n"
        )
    }

    #[test]
    fn the_daemon_is_started_embedded_on_our_socket_and_leaves_when_we_do() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let binary = fake(dir.path(), &serving(&log));
        let socket = dir.path().join("s.sock").display().to_string();
        let mut host = Host::start(&binary, &socket, "dev.fastvibe.test").unwrap();
        assert!(host.alive());
        let said = std::fs::read_to_string(&log).unwrap();
        assert!(
            said.contains(&format!("['serve', '--embedded', '--socket', '{socket}']")),
            "{said}"
        );
        assert!(said.contains("CUA_DRIVER_EMBEDDED=1"), "{said}");
        assert!(
            said.contains("CUA_DRIVER_HOST_BUNDLE_ID=dev.fastvibe.test"),
            "{said}"
        );
        assert!(said.contains("CUA_DRIVER_RS_TELEMETRY_ENABLED=0"), "{said}");
        assert!(
            said.contains("CUA_DRIVER_PERMISSION_MODE=standard"),
            "{said}"
        );
        assert!(
            said.contains("CUA_DRIVER_PARENT_LIVENESS_STDIN=1"),
            "{said}"
        );
        assert!(
            !said.contains("RESPONSIBILITY_DISCLAIMED"),
            "disclaiming responsibility would move the grants to another identity: {said}"
        );
        host.stop();
        assert!(!host.alive());
        assert!(!Path::new(&socket).exists(), "the socket is removed");
    }

    #[test]
    fn dropping_the_host_ends_the_daemon() {
        let dir = tempfile::tempdir().unwrap();
        let binary = fake(dir.path(), &serving(&dir.path().join("log")));
        let socket = dir.path().join("s.sock").display().to_string();
        let host = Host::start(&binary, &socket, "x").unwrap();
        let pid = host.child.id();
        drop(host);
        // SAFETY: signal 0 only checks that the process exists.
        let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
        assert!(!alive, "the daemon must not outlive its host");
    }

    #[test]
    fn a_daemon_that_dies_at_start_reports_what_it_said() {
        let dir = tempfile::tempdir().unwrap();
        let binary = fake(
            dir.path(),
            "#!/bin/sh\necho 'permission denied for capture' >&2\nexit 3\n",
        );
        let socket = dir.path().join("s.sock").display().to_string();
        let error = Host::start(&binary, &socket, "x").err().unwrap();
        assert!(error.contains("permission denied for capture"), "{error}");
        let missing = Host::start(&dir.path().join("nope"), &socket, "x")
            .err()
            .unwrap();
        assert!(missing.contains("找不到"), "{missing}");
    }

    #[test]
    fn the_endpoint_is_short_enough_for_a_unix_socket() {
        assert!(endpoint().len() < 100, "{}", endpoint());
    }
}
