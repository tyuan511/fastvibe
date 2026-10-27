//! Environment for subprocesses launched by a desktop app or a detached server.
//! Read the login shell once, without mutating the multithreaded process's environment.
//! Only PATH, SHELL and locale values cross this boundary; shell output is never logged.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use tokio::sync::OnceCell;

const NAMES: &[&str] = &["PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE"];
static ENVIRONMENT: OnceCell<Environment> = OnceCell::const_new();

pub struct Environment {
    pub values: BTreeMap<OsString, OsString>,
    pub warning: Option<&'static str>,
}

pub fn user_shell() -> PathBuf {
    if let Some(shell) = std::env::var_os("SHELL").filter(|s| !s.is_empty()) {
        return shell.into();
    }
    #[cfg(unix)]
    {
        // getpwuid_r copies the account's default shell into our own buffer. Unlike getpwuid,
        // it does not share storage with a concurrent lookup on another thread.
        let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        let mut buffer = vec![0u8; 16 * 1024];
        let status = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                record.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == 0 && !result.is_null() {
            let record = unsafe { record.assume_init() };
            if !record.pw_shell.is_null() {
                use std::os::unix::ffi::OsStrExt;
                let bytes = unsafe { std::ffi::CStr::from_ptr(record.pw_shell) }.to_bytes();
                if !bytes.is_empty() {
                    return PathBuf::from(OsStr::from_bytes(bytes));
                }
            }
        }
    }
    if cfg!(windows) {
        "cmd.exe".into()
    } else {
        "/bin/sh".into()
    }
}

fn inherited() -> BTreeMap<OsString, OsString> {
    let mut values: BTreeMap<_, _> = NAMES
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (OsString::from(name), value)))
        .collect();
    values.insert("SHELL".into(), user_shell().into_os_string());
    utf8_fallback(&mut values);
    values
}

fn utf8_fallback(values: &mut BTreeMap<OsString, OsString>) {
    if !cfg!(windows)
        && ["LC_ALL", "LC_CTYPE", "LANG"].iter().all(|name| {
            values
                .get(OsStr::new(name))
                .is_none_or(|value| value.is_empty())
        })
    {
        values.insert(
            "LC_CTYPE".into(),
            if cfg!(target_os = "macos") {
                "en_US.UTF-8"
            } else {
                "C.UTF-8"
            }
            .into(),
        );
    }
}

/// A nonblocking caller should initialize before accepting clients. A library embedding that
/// does not initialize still gets the inherited environment and UTF-8 fallback.
pub fn snapshot() -> BTreeMap<OsString, OsString> {
    ENVIRONMENT
        .get()
        .map(|env| env.values.clone())
        .unwrap_or_else(inherited)
}

pub async fn initialize() -> &'static Environment {
    ENVIRONMENT
        .get_or_init(|| async {
            let mut values = inherited();
            #[cfg(unix)]
            let warning = match unix::capture(
                &user_shell(),
                std::time::Duration::from_secs(3),
                256 * 1024,
            )
            .await
            {
                Ok(captured) => {
                    values.extend(captured);
                    None
                }
                Err(()) => Some(
                    "Login shell environment was unavailable; using the inherited PATH and locale.",
                ),
            };
            #[cfg(not(unix))]
            let warning = None;
            utf8_fallback(&mut values);
            Environment { values, warning }
        })
        .await
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    const MARKER: &[u8] = b"\0FASTVIBE_LOGIN_ENV\0";
    struct Group(u32);
    impl Drop for Group {
        fn drop(&mut self) {
            unsafe {
                libc::kill(-(self.0 as i32), libc::SIGKILL);
            }
        }
    }

    pub(super) async fn capture(
        shell: &Path,
        deadline: Duration,
        limit: usize,
    ) -> Result<BTreeMap<OsString, OsString>, ()> {
        let mut child = tokio::process::Command::new(shell)
            .args([
                "-ilc",
                "printf '\\000FASTVIBE_LOGIN_ENV\\000'; /usr/bin/env -0",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| ())?;
        let _group = Group(child.id().ok_or(())?);
        let mut stdout = child.stdout.take().ok_or(())?.take(limit as u64 + 1);
        let mut bytes = Vec::new();
        let completed = tokio::time::timeout(deadline, async {
            stdout.read_to_end(&mut bytes).await.map_err(|_| ())?;
            if bytes.len() > limit {
                return Err(());
            }
            if !child.wait().await.map_err(|_| ())?.success() {
                return Err(());
            }
            Ok(())
        })
        .await;
        if !matches!(completed, Ok(Ok(()))) {
            // Reap the leader too. The group guard handles descendants and also runs if this
            // future is canceled during shell startup.
            drop(_group);
            let _ = child.kill().await;
            return Err(());
        }
        parse(&bytes)
    }

    fn parse(bytes: &[u8]) -> Result<BTreeMap<OsString, OsString>, ()> {
        let start = bytes
            .windows(MARKER.len())
            .position(|part| part == MARKER)
            .ok_or(())?
            + MARKER.len();
        let mut values = BTreeMap::new();
        for entry in bytes[start..].split(|b| *b == 0) {
            let Some(eq) = entry.iter().position(|b| *b == b'=') else {
                continue;
            };
            let name = &entry[..eq];
            let value = &entry[eq + 1..];
            if NAMES.iter().any(|allowed| allowed.as_bytes() == name) && !value.starts_with(b"()") {
                values.insert(
                    OsStr::from_bytes(name).to_owned(),
                    OsStr::from_bytes(value).to_owned(),
                );
            }
        }
        if values
            .get(OsStr::new("PATH"))
            .is_none_or(|path| path.is_empty())
        {
            return Err(());
        }
        Ok(values)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        fn script(dir: &Path, body: &str) -> PathBuf {
            let path = dir.join("login-shell");
            std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
        #[tokio::test]
        async fn login_output_is_framed_and_only_path_shell_and_locale_are_retained() {
            let dir = tempfile::tempdir().unwrap();
            let shell = script(
                dir.path(),
                "printf 'profile chatter\\n\\000FASTVIBE_LOGIN_ENV\\000PATH=/custom node/bin:/usr/bin\\000LANG=zh_CN.UTF-8\\000API_KEY=private\\000SHELL=/bin/zsh\\000LC_ALL=\\000'\n",
            );
            let values = capture(&shell, Duration::from_secs(2), 4096).await.unwrap();
            assert_eq!(values[OsStr::new("PATH")], "/custom node/bin:/usr/bin");
            assert_eq!(values[OsStr::new("LANG")], "zh_CN.UTF-8");
            assert!(!values.contains_key(OsStr::new("API_KEY")));
            let mut command = tokio::process::Command::new("/bin/sh");
            let out = command
                .args(["-c", "printf '%s' \"$PATH\""])
                .envs(values)
                .output()
                .await
                .unwrap();
            assert_eq!(out.stdout, b"/custom node/bin:/usr/bin");
        }
        #[tokio::test]
        #[cfg(target_os = "macos")]
        async fn an_actual_login_shell_finds_a_command_installed_by_the_users_profile() {
            let dir = tempfile::tempdir().unwrap();
            let bin = dir.path().join("node tools/bin");
            std::fs::create_dir_all(&bin).unwrap();
            let command = bin.join("npx");
            std::fs::write(&command, "#!/bin/sh\nprintf 'profile command found'\n").unwrap();
            std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::fs::write(dir.path().join(".zshrc"), format!("export PATH='{}':$PATH\nexport PRIVATE_PROFILE_KEY=hidden\nprintf 'welcome to my shell\\n'\n", bin.display())).unwrap();
            // ZDOTDIR is local to this wrapper; neither the test process's global environment
            // nor the user's real shell profiles are changed.
            let shell = script(
                dir.path(),
                &format!(
                    "export ZDOTDIR='{}'\nexec /bin/zsh \"$@\"\n",
                    dir.path().display()
                ),
            );
            let values = capture(&shell, Duration::from_secs(3), 256 * 1024)
                .await
                .unwrap();
            assert!(!values.contains_key(OsStr::new("PRIVATE_PROFILE_KEY")));
            let out = tokio::process::Command::new("npx")
                .envs(values)
                .output()
                .await
                .unwrap();
            assert!(out.status.success());
            assert_eq!(out.stdout, b"profile command found");
        }

        #[tokio::test]
        async fn hung_profiles_are_bounded_and_their_process_group_is_killed() {
            let dir = tempfile::tempdir().unwrap();
            let shell = script(
                dir.path(),
                &format!(
                    "echo $$ > '{}'; sleep 60 & echo $! > '{}'; wait",
                    dir.path().join("parent").display(),
                    dir.path().join("child").display()
                ),
            );
            assert!(capture(&shell, Duration::from_secs(3), 4096).await.is_err());
            for name in ["parent", "child"] {
                let pid: i32 = std::fs::read_to_string(dir.path().join(name))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                tokio::time::timeout(Duration::from_secs(3), async {
                    while unsafe { libc::kill(pid, 0) } == 0 {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .unwrap();
            }
        }
        #[tokio::test]
        async fn invalid_or_excessive_output_falls_back_without_retaining_it() {
            let dir = tempfile::tempdir().unwrap();
            let shell = script(dir.path(), "printf 'unframed PATH=/wrong'\n");
            assert!(capture(&shell, Duration::from_secs(1), 4096).await.is_err());
            let shell = script(dir.path(), "yes flood\n");
            assert!(capture(&shell, Duration::from_secs(1), 4096).await.is_err());
            assert!(parse(b"\0FASTVIBE_LOGIN_ENV\0PATH=\0").is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_is_only_a_fallback_and_respects_an_explicit_c_locale() {
        let mut values = BTreeMap::new();
        utf8_fallback(&mut values);
        if !cfg!(windows) {
            assert!(values.contains_key(OsStr::new("LC_CTYPE")));
        }
        let mut values = BTreeMap::from([("LANG".into(), "C".into())]);
        utf8_fallback(&mut values);
        assert!(!values.contains_key(OsStr::new("LC_CTYPE")));
    }
}

mod office;
pub use office::{OfficeInstall, office_install, snapshot_for};
