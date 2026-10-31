//! The native preview channel. Never reads Electron's latest release or update manifests.
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const REPO: &str = "https://github.com/tyuan511/fastvibe";
const API: &str = "https://api.github.com/repos/tyuan511/fastvibe/releases";
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;
const MAX_UNPACKED: u64 = 1024 * 1024 * 1024;
pub const BUNDLE_NAME: &str = "FastVibe Native.app";
pub const BUNDLE_ID: &str = "dev.fastvibe.native";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub notes: String,
    download: String,
    sha256: String,
    bytes: u64,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

fn client(proxy: &str) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .user_agent("FastVibe-native-updater");
    if !proxy.is_empty() {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| e.to_string())?);
    }
    builder.build().map_err(|e| e.to_string())
}

fn select(releases: Vec<GithubRelease>, current: &Version) -> Option<Release> {
    releases
        .into_iter()
        .filter_map(|release| {
            // A native release must remain a prerelease, even if Cargo's version has no suffix.
            if release.draft || !release.prerelease {
                return None;
            }
            let version = Version::parse(release.tag_name.strip_prefix("native-v")?).ok()?;
            if version <= *current {
                return None;
            }
            let name = format!("FastVibe-Native-{version}-mac-arm64.zip");
            let expected = format!("{REPO}/releases/download/{}/{name}", release.tag_name);
            let asset = release.assets.into_iter().find(|a| a.name == name)?;
            if asset.browser_download_url != expected
                || asset.size == 0
                || asset.size > MAX_DOWNLOAD
            {
                return None;
            }
            let digest = asset.digest?.strip_prefix("sha256:")?.to_string();
            if digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            Some((
                version.clone(),
                Release {
                    version: version.to_string(),
                    url: format!("{REPO}/releases/tag/{}", release.tag_name),
                    notes: release
                        .body
                        .unwrap_or_default()
                        .chars()
                        .take(16_000)
                        .collect(),
                    download: expected,
                    sha256: digest.to_ascii_lowercase(),
                    bytes: asset.size,
                },
            ))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, release)| release)
}

/// GitHub's latest endpoint excludes previews; list releases and filter our own tag namespace.
pub async fn check(current: &str, proxy: &str) -> Result<Option<Release>, String> {
    let current = Version::parse(current).map_err(|e| e.to_string())?;
    let client = client(proxy)?;
    let mut releases = Vec::new();
    // Pagination matters: mobile / agent / Electron releases share this repository.
    for page in 1..=10 {
        let mut response = client
            .get(format!("{API}?per_page=100&page={page}"))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err("release metadata too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let batch: Vec<GithubRelease> =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let last = batch.len() < 100;
        releases.extend(batch);
        if last {
            return Ok(select(releases, &current));
        }
    }
    Err("too many releases to check the native preview channel".into())
}

/// Temporary files are owned by this value; closing About before installing cleans them up.
pub struct PreparedUpdate {
    directory: tempfile::TempDir,
    pub version: String,
}

pub async fn prepare(release: Release, proxy: &str) -> Result<PreparedUpdate, String> {
    let directory = tempfile::Builder::new()
        .prefix("fastvibe-native-update-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let archive = directory.path().join("update.zip");
    let mut response = client(proxy)?
        .get(&release.download)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut file = tokio::fs::File::create(&archive)
        .await
        .map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut received = 0u64;
    use tokio::io::AsyncWriteExt as _;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        received += chunk.len() as u64;
        if received > release.bytes || received > MAX_DOWNLOAD {
            return Err("update download exceeds its declared size".into());
        }
        digest.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if received != release.bytes || format!("{:x}", digest.finalize()) != release.sha256 {
        return Err("update download checksum mismatch".into());
    }
    tokio::task::spawn_blocking(move || {
        unpack(&archive, directory.path())?;
        validate_app(&directory.path().join(BUNDLE_NAME), &release.version)?;
        Ok(PreparedUpdate {
            directory,
            version: release.version,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn unpack(archive: &Path, destination: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut total = 0u64;
    if zip.len() > 20_000 {
        return Err("too many update files".into());
    }
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let relative = entry.enclosed_name().ok_or("update path escapes archive")?;
        if !relative.starts_with(BUNDLE_NAME)
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("unexpected update archive entry".into());
        }
        total = total
            .checked_add(entry.size())
            .ok_or("update archive too large")?;
        if total > MAX_UNPACKED {
            return Err("update archive too large".into());
        }
        let path = destination.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            continue;
        }
        std::fs::create_dir_all(path.parent().ok_or("invalid update path")?)
            .map_err(|e| e.to_string())?;
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let expected = entry.size();
        if std::io::copy(&mut entry.by_ref().take(expected + 1), &mut output)
            .map_err(|e| e.to_string())?
            != expected
        {
            return Err("update entry size mismatch".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(
                &path,
                std::fs::Permissions::from_mode(entry.unix_mode().unwrap_or(0o644) & 0o777),
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn validate_app(app: &Path, version: &str) -> Result<(), String> {
    let contents = app.join("Contents");
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(contents.join("Resources/native-manifest.json"))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if manifest["schema"] != 1
        || manifest["platform"] != "mac"
        || manifest["arch"] != "arm64"
        || manifest["version"] != version
    {
        return Err("wrong native update version or architecture".into());
    }
    let plist = std::fs::read_to_string(contents.join("Info.plist")).map_err(|e| e.to_string())?;
    if !plist.contains(&format!("<string>{BUNDLE_ID}</string>")) {
        return Err("wrong update application identity".into());
    }
    for binary in ["fastvibe", "fastvibe-server"] {
        let path = contents.join("MacOS").join(binary);
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err("missing native update executable".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err("update binary is not executable".into());
            }
        }
    }
    Ok(())
}

/// Only replace our own packaged app. A dev executable or an app mounted from a DMG cannot update.
pub fn installed_app(executable: &Path) -> Result<PathBuf, String> {
    let macos = executable
        .parent()
        .ok_or("not a packaged native application")?;
    let contents = macos.parent().ok_or("not a packaged native application")?;
    let app = contents
        .parent()
        .ok_or("not a packaged native application")?;
    if macos.file_name().is_none_or(|n| n != "MacOS")
        || contents.file_name().is_none_or(|n| n != "Contents")
        || app.extension().is_none_or(|n| n != "app")
    {
        return Err("install the native preview app before updating".into());
    }
    if app.starts_with("/Volumes") || app.to_string_lossy().contains("/AppTranslocation/") {
        return Err("move FastVibe Native to Applications before updating".into());
    }
    let plist = std::fs::read_to_string(contents.join("Info.plist")).map_err(|e| e.to_string())?;
    if !plist.contains(&format!("<string>{BUNDLE_ID}</string>")) {
        return Err("not the native preview application".into());
    }
    Ok(app.into())
}

pub const INSTALL_SCRIPT: &str = include_str!("install-macos.sh");

/// The packager uses the same extraction and identity checks as the in-app updater.
pub fn verify_archive(archive: &Path, version: &str) -> Result<(), String> {
    let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
    unpack(archive, directory.path())?;
    validate_app(&directory.path().join(BUNDLE_NAME), version)
}

impl PreparedUpdate {
    /// Starts a detached helper, then the caller must quit normally. The server may finish its
    /// current turns; `Daemon::connect_current` adopts the new server once it is idle.
    pub fn install(self, executable: &Path, data_dir: &Path) -> Result<(), String> {
        let app = installed_app(executable)?;
        let parent = app.parent().ok_or("invalid application path")?;
        // Test write permissions before telling the user to quit.
        let probe = tempfile::Builder::new()
            .prefix(".fastvibe-write-")
            .tempdir_in(parent)
            .map_err(|e| e.to_string())?;
        drop(probe);
        let script = self.directory.path().join("install.sh");
        std::fs::write(&script, INSTALL_SCRIPT).map_err(|e| e.to_string())?;
        let log =
            std::fs::File::create(data_dir.join("native-update.log")).map_err(|e| e.to_string())?;
        let mut command = std::process::Command::new("/bin/bash");
        command
            .arg(&script)
            .arg(std::process::id().to_string())
            .arg(&app)
            .arg(self.directory.path())
            .arg(data_dir)
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let _ = self.directory.keep(); // The helper owns cleanup after its parent exits.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn preview(version: &str) -> serde_json::Value {
        let name = format!("FastVibe-Native-{version}-mac-arm64.zip");
        json!({ "tag_name": format!("native-v{version}"), "draft": false, "prerelease": true,
            "body": "Native preview", "assets": [{ "name": name,
                "browser_download_url": format!("{REPO}/releases/download/native-v{version}/{name}"),
                "size": 123, "digest": format!("sha256:{}", "a".repeat(64)) }] })
    }
    fn choose(values: Vec<serde_json::Value>, current: &str) -> Option<Release> {
        select(
            serde_json::from_value(json!(values)).unwrap(),
            &Version::parse(current).unwrap(),
        )
    }
    #[test]
    fn channel_excludes_electron_mobile_agent_drafts_and_non_preview_releases() {
        let mut values = vec![];
        for tag in [
            "v99.0.0",
            "app-v99.0.0",
            "agent-runtime-v99.0.0",
            "native-vinvalid",
        ] {
            let mut release = preview("99.0.0");
            release["tag_name"] = json!(tag);
            values.push(release);
        }
        let mut draft = preview("99.0.0");
        draft["draft"] = json!(true);
        values.push(draft);
        let mut stable = preview("99.0.0");
        stable["prerelease"] = json!(false);
        values.push(stable);
        values.push(preview("0.2.0-beta.1"));
        assert_eq!(choose(values, "0.1.0").unwrap().version, "0.2.0-beta.1");
    }
    #[test]
    fn semver_order_does_not_follow_publish_order_or_offer_a_downgrade() {
        let values = vec![
            preview("0.2.0-beta.10"),
            preview("0.2.0-beta.2"),
            preview("0.1.9"),
        ];
        assert_eq!(
            choose(values, "0.2.0-beta.1").unwrap().version,
            "0.2.0-beta.10"
        );
        assert!(choose(vec![preview("0.1.0"), preview("0.0.9")], "0.1.0").is_none());
    }
    #[test]
    fn only_the_exact_arm_archive_with_a_github_sha256_is_installable() {
        for (key, value) in [
            ("name", json!("FastVibe-0.2.0.zip")),
            (
                "browser_download_url",
                json!("https://example.org/payload.zip"),
            ),
            ("size", json!(0)),
            ("size", json!(MAX_DOWNLOAD + 1)),
            ("digest", json!(null)),
            ("digest", json!("sha256:bad")),
        ] {
            let mut release = preview("0.2.0");
            release["assets"][0][key] = value;
            assert!(choose(vec![release], "0.1.0").is_none(), "{key}");
        }
    }
    fn archive(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, bytes, mode) in entries {
            writer
                .start_file(
                    *name,
                    zip::write::SimpleFileOptions::default().unix_permissions(*mode),
                )
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    fn app_archive() -> Vec<u8> {
        archive(&[
            (
                "FastVibe Native.app/Contents/Resources/native-manifest.json",
                br#"{"schema":1,"platform":"mac","arch":"arm64","version":"0.2.0"}"#,
                0o644,
            ),
            (
                "FastVibe Native.app/Contents/Info.plist",
                b"<string>dev.fastvibe.native</string>",
                0o644,
            ),
            (
                "FastVibe Native.app/Contents/MacOS/fastvibe",
                b"#!/bin/sh\nexit 0\n",
                0o755,
            ),
            (
                "FastVibe Native.app/Contents/MacOS/fastvibe-server",
                b"#!/bin/sh\nexit 0\n",
                0o755,
            ),
        ])
    }
    #[test]
    fn archive_paths_cannot_escape_or_replace_an_unrelated_app() {
        for name in [
            "../escape",
            "/tmp/escape",
            "Electron.app/Contents/MacOS/fastvibe",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("input.zip");
            std::fs::write(&path, archive(&[(name, b"payload", 0o644)])).unwrap();
            assert!(unpack(&path, &temp.path().join("out")).is_err(), "{name}");
        }
    }
    #[test]
    fn app_validation_rejects_wrong_arch_version_identity_and_dev_install_paths() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("input.zip");
        std::fs::write(&path, app_archive()).unwrap();
        unpack(&path, temp.path()).unwrap();
        let app = temp.path().join(BUNDLE_NAME);
        validate_app(&app, "0.2.0").unwrap();
        assert!(validate_app(&app, "0.3.0").is_err());
        assert!(installed_app(Path::new("/tmp/target/debug/fastvibe")).is_err());
        assert!(
            installed_app(Path::new(
                "/Volumes/Test/FastVibe Native.app/Contents/MacOS/fastvibe"
            ))
            .is_err()
        );
        std::fs::write(
            app.join("Contents/Info.plist"),
            "<string>dev.fastvibe.electron</string>",
        )
        .unwrap();
        assert!(validate_app(&app, "0.2.0").is_err());
        assert!(installed_app(&app.join("Contents/MacOS/fastvibe")).is_err());
    }
    async fn serve(bytes: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 8192];
            let _ = socket.read(&mut request).await.unwrap();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(&bytes).await.unwrap();
        });
        (format!("http://{address}/update.zip"), task)
    }
    #[tokio::test]
    async fn download_checks_bytes_before_unpacking_and_owns_its_temporary_files() {
        let bytes = app_archive();
        let (url, task) = serve(bytes.clone()).await;
        let mut release = choose(vec![preview("0.2.0")], "0.1.0").unwrap();
        release.download = url;
        release.bytes = bytes.len() as u64;
        release.sha256 = format!("{:x}", Sha256::digest(&bytes));
        let prepared = prepare(release, "").await.unwrap();
        task.await.unwrap();
        let path = prepared.directory.path().to_owned();
        assert!(
            path.join(BUNDLE_NAME)
                .join("Contents/MacOS/fastvibe")
                .is_file()
        );
        drop(prepared);
        assert!(!path.exists());
        let (url, task) = serve(bytes.clone()).await;
        let mut release = choose(vec![preview("0.2.0")], "0.1.0").unwrap();
        release.download = url;
        release.bytes = bytes.len() as u64;
        assert!(
            prepare(release, "")
                .await
                .err()
                .unwrap()
                .contains("checksum mismatch")
        );
        task.await.unwrap();
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn installer_rolls_back_failed_launches_but_preserves_clean_gui_exit() {
        use std::os::unix::fs::PermissionsExt;
        for (body, fails) in [
            ("#!/bin/sh\nexit 0\n", false),
            ("#!/bin/sh\nsleep 3.4\nexit 0\n", false),
            ("#!/bin/sh\nexit 17\n", true),
            ("#!/no/such/interpreter\n", true),
            ("#!/bin/sh\nsleep 0.4\nexit 23\n", true),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let app = temp.path().join("Installed Native.app");
            let work = temp.path().join("work");
            for path in [
                app.join("Contents/MacOS"),
                work.join(BUNDLE_NAME).join("Contents/MacOS"),
            ] {
                std::fs::create_dir_all(path).unwrap();
            }
            let old = app.join("Contents/MacOS/fastvibe");
            let marker = temp.path().join("old-relaunched");
            std::fs::write(
                &old,
                format!("#!/bin/sh\nprintf old > '{}'\n", marker.display()),
            )
            .unwrap();
            std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o755)).unwrap();
            let new = work.join(BUNDLE_NAME).join("Contents/MacOS/fastvibe");
            std::fs::write(&new, body).unwrap();
            std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755)).unwrap();
            let output = std::process::Command::new("/bin/bash")
                .arg("-c")
                .arg(INSTALL_SCRIPT)
                .arg("test-install")
                .arg("999999999")
                .arg(&app)
                .arg(&work)
                .arg(temp.path())
                .output()
                .unwrap();
            assert_eq!(
                output.status.success(),
                !fails,
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let installed = std::fs::read_to_string(app.join("Contents/MacOS/fastvibe")).unwrap();
            assert_eq!(installed == body, !fails, "{installed}");
            if fails {
                for _ in 0..50 {
                    if marker.exists() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                assert!(marker.exists(), "the previous fixture is relaunched");
            } else {
                assert!(
                    !marker.exists(),
                    "a clean exit must not relaunch the old app"
                );
            }
            assert!(!work.exists());
            assert!(!std::fs::read_dir(temp.path()).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".fastvibe-native-")
            }));
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn installer_waits_for_normal_parent_exit_before_swapping() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("Installed Native.app");
        let work = temp.path().join("work");
        let archive = temp.path().join("input.zip");
        std::fs::write(&archive, app_archive()).unwrap();
        unpack(&archive, &work).unwrap();
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("old"), "old").unwrap();
        // A real parent fixture remains live until its stdin closes. The helper must wait;
        // no signal or forced quit is used to make the application leave.
        let mut parent = std::process::Command::new("/bin/sh")
            .args(["-c", "read line"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let helper = std::process::Command::new("/bin/bash")
            .arg("-c")
            .arg(INSTALL_SCRIPT)
            .arg("test-install")
            .arg(parent.id().to_string())
            .arg(&app)
            .arg(&work)
            .arg(temp.path())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(350));
        assert!(
            app.join("old").exists(),
            "a running GUI keeps its app intact"
        );
        assert!(
            parent.try_wait().unwrap().is_none(),
            "installer must not terminate the parent"
        );
        drop(parent.stdin.take());
        parent.wait().unwrap();
        let output = helper.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!app.join("old").exists());
        assert!(app.join("Contents/MacOS/fastvibe").exists());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn installer_swaps_only_the_fixture_app_and_rolls_back_a_failed_rename() {
        use std::os::unix::fs::PermissionsExt;
        for fail in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let app = temp.path().join("Installed Native.app");
            let work = temp.path().join("work");
            let source = work.join(BUNDLE_NAME).join("Contents/MacOS");
            std::fs::create_dir_all(&source).unwrap();
            std::fs::create_dir_all(&app).unwrap();
            std::fs::write(app.join("old"), "old").unwrap();
            let dummy = source.join("fastvibe");
            // A shell fixture, never the GUI or any desktop application.
            std::fs::write(&dummy, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(&dummy, std::fs::Permissions::from_mode(0o755)).unwrap();
            let bin = temp.path().join("tools");
            std::fs::create_dir(&bin).unwrap();
            let mv = bin.join("mv");
            std::fs::write(&mv, if fail { "#!/bin/sh\ncase \"$1\" in */.fastvibe-native-stage.*/app) exit 1;; esac\nexec /bin/mv \"$@\"\n" } else { "#!/bin/sh\nexec /bin/mv \"$@\"\n" }).unwrap();
            std::fs::set_permissions(&mv, std::fs::Permissions::from_mode(0o755)).unwrap();
            let output = std::process::Command::new("/bin/bash")
                .arg("-c")
                .arg(INSTALL_SCRIPT)
                .arg("test-install")
                .arg("999999999")
                .arg(&app)
                .arg(&work)
                .arg(temp.path())
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .output()
                .unwrap();
            assert_eq!(
                output.status.success(),
                !fail,
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(app.join("old").exists(), fail);
            assert_eq!(app.join("Contents/MacOS/fastvibe").exists(), !fail);
            assert!(!work.exists());
        }
    }
}
