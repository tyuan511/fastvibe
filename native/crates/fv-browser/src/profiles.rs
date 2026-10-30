use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Engine {
    pub id: &'static str,
    pub label: &'static str,
    pub binary: PathBuf,
    pub root: PathBuf,
}
#[derive(Clone, Debug)]
pub struct Profile {
    pub id: String,
    pub browser: String,
    pub name: String,
    pub cookie_path: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
}
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}
pub fn engines() -> Vec<Engine> {
    let h = home();
    #[cfg(target_os = "macos")]
    let choices = [
        (
            "chrome",
            "Google Chrome",
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Google/Chrome",
        ),
        (
            "edge",
            "Microsoft Edge",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Microsoft Edge",
        ),
        (
            "brave",
            "Brave",
            "Brave Browser.app/Contents/MacOS/Brave Browser",
            "BraveSoftware/Brave-Browser",
        ),
        (
            "chromium",
            "Chromium",
            "Chromium.app/Contents/MacOS/Chromium",
            "Chromium",
        ),
        ("arc", "Arc", "Arc.app/Contents/MacOS/Arc", "Arc/User Data"),
        (
            "opera",
            "Opera",
            "Opera.app/Contents/MacOS/Opera",
            "com.operasoftware.Opera",
        ),
    ];
    #[cfg(not(target_os = "macos"))]
    let choices = [
        ("chrome", "Google Chrome", "google-chrome", "google-chrome"),
        ("edge", "Microsoft Edge", "microsoft-edge", "microsoft-edge"),
        (
            "brave",
            "Brave",
            "brave-browser",
            "BraveSoftware/Brave-Browser",
        ),
        ("chromium", "Chromium", "chromium", "chromium"),
    ];
    choices
        .into_iter()
        .filter_map(|(id, label, binary, root)| {
            #[cfg(target_os = "macos")]
            let (binary, root) = (
                [
                    PathBuf::from("/Applications").join(binary),
                    h.join("Applications").join(binary),
                ]
                .into_iter()
                .find(|p| p.is_file())?,
                h.join("Library/Application Support").join(root),
            );
            #[cfg(not(target_os = "macos"))]
            let (binary, root) = (
                std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                    .map(|p| p.join(binary))
                    .find(|p| p.is_file())?,
                std::env::var_os("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| h.join(".config"))
                    .join(root),
            );
            Some(Engine {
                id,
                label,
                binary,
                root,
            })
        })
        .collect()
}
pub fn profiles() -> Vec<Profile> {
    engines()
        .into_iter()
        .flat_map(|e| profiles_at(e.label, &e.root))
        .collect()
}
fn profiles_at(browser: &str, root: &Path) -> Vec<Profile> {
    let names: serde_json::Value = std::fs::read(root.join("Local State"))
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    let mut result = vec![];
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().to_string();
        if id != "Default"
            && !id
                .strip_prefix("Profile ")
                .is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        {
            continue;
        }
        let cookie_path = [
            entry.path().join("Network/Cookies"),
            entry.path().join("Cookies"),
        ]
        .into_iter()
        .find(|p| p.is_file());
        if let Some(cookie_path) = cookie_path {
            result.push(Profile {
                id: format!("{browser}:{id}"),
                browser: browser.into(),
                name: names["profile"]["info_cache"][&id]["name"]
                    .as_str()
                    .unwrap_or(&id)
                    .into(),
                cookie_path,
            });
        }
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    result
}
fn storage_key(browser: &str) -> Option<[u8; 16]> {
    #[cfg(target_os = "macos")]
    {
        let service = match browser {
            "Google Chrome" => "Chrome Safe Storage".into(),
            "Brave" => "Brave Safe Storage".into(),
            _ => format!("{browser} Safe Storage"),
        };
        let output = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-w", "-s", &service])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let password = String::from_utf8(output.stdout).ok()?;
        let mut key = [0; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(
            password.trim_end().as_bytes(),
            b"saltysalt",
            1003,
            &mut key,
        );
        Some(key)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = browser;
        None
    }
}
fn decrypt(raw: &[u8], key: Option<&[u8; 16]>, host: &str, version: i64) -> Option<String> {
    if !raw.starts_with(b"v10") && !raw.starts_with(b"v11") {
        return None;
    }
    let data = cbc::Decryptor::<aes::Aes128>::new(key?.into(), b"                ".into())
        .decrypt_padded_vec_mut::<Pkcs7>(&raw[3..])
        .ok()?;
    let value = if version >= 24 {
        let digest = Sha256::digest(host.as_bytes());
        if data.get(..32)? != digest.as_slice() {
            return None;
        }
        &data[32..]
    } else {
        &data
    };
    String::from_utf8(value.to_vec()).ok()
}
/// Return usable cookies and a skipped count; never change the source database or its WAL.
pub fn read_cookies(profile: &Profile) -> Result<(Vec<Cookie>, usize), String> {
    read_cookies_with_key(profile, storage_key(&profile.browser))
}
fn read_cookies_with_key(
    profile: &Profile,
    key: Option<[u8; 16]>,
) -> Result<(Vec<Cookie>, usize), String> {
    let source = rusqlite::Connection::open_with_flags(
        &profile.cookie_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    source
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut db =
        rusqlite::Connection::open(temp.path().join("cookies")).map_err(|e| e.to_string())?;
    rusqlite::backup::Backup::new(&source, &mut db)
        .and_then(|b| b.run_to_completion(256, std::time::Duration::from_millis(5), None))
        .map_err(|e| e.to_string())?;
    let version = db
        .query_row("SELECT value FROM meta WHERE key='version'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let mut query = db.prepare("SELECT host_key,name,path,value,encrypted_value,expires_utc,is_secure,is_httponly,samesite FROM cookies").map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Vec<u8>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, bool>(6)?,
                r.get::<_, bool>(7)?,
                r.get::<_, i32>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    let mut skipped = 0;
    for row in rows {
        let (domain, name, path, plain, encrypted, expires, secure, http_only, same_site) =
            row.map_err(|e| e.to_string())?;
        let expires = if expires == 0 {
            None
        } else {
            Some((expires as f64 - 11_644_473_600_000_000.) / 1_000_000.)
        };
        if expires.is_some_and(|e| e <= now) {
            skipped += 1;
            continue;
        }
        let value = if encrypted.is_empty() {
            Some(plain)
        } else {
            decrypt(&encrypted, key.as_ref(), &domain, version)
        };
        let Some(value) = value else {
            skipped += 1;
            continue;
        };
        if name.is_empty() || domain.is_empty() {
            skipped += 1;
            continue;
        }
        out.push(Cookie {
            name,
            value,
            domain,
            path,
            secure,
            http_only,
            expires,
            same_site: match same_site {
                0 => Some("None".into()),
                1 => Some("Lax".into()),
                2 => Some("Strict".into()),
                _ => None,
            },
        });
    }
    Ok((out, skipped))
}
#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;
    #[test]
    fn snapshot_reads_wal_and_skips_expired_or_unreadable_cookies_without_modifying_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Cookies");
        let source = rusqlite::Connection::open(&path).unwrap();
        source.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value TEXT,encrypted_value BLOB,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER);").unwrap();
        for (name, value, encrypted, expiry) in [
            ("session", "plain", vec![], 0i64),
            ("empty", "", vec![], 0),
            ("expired", "old", vec![], 11_644_473_601_000_000),
            ("encrypted", "", b"v10no-key".to_vec(), 0),
        ] {
            source
                .execute(
                    "INSERT INTO cookies VALUES('.example.com',?1,'/',?2,?3,?4,1,1,1)",
                    rusqlite::params![name, value, encrypted, expiry],
                )
                .unwrap();
        }
        let profile = Profile {
            id: "test".into(),
            browser: "test".into(),
            name: "test".into(),
            cookie_path: path,
        };
        let (cookies, skipped) = read_cookies_with_key(&profile, None).unwrap();
        assert_eq!(cookies.len(), 2);
        assert_eq!(cookies[0].name, "session");
        assert_eq!(cookies[1].value, "");
        assert_eq!(skipped, 2);
        assert!(cookies[0].http_only && cookies[0].secure);
        assert!(cookies[0].expires.is_none());
        assert_eq!(
            source
                .query_row("SELECT count(*) FROM cookies", [], |r| r.get::<_, usize>(0))
                .unwrap(),
            4
        );
    }
    #[test]
    fn encrypted_cookie_digest_is_versioned_and_checked() {
        let key = [7; 16];
        let encrypt = |data: &[u8]| {
            let mut v = b"v10".to_vec();
            v.extend(
                cbc::Encryptor::<aes::Aes128>::new((&key).into(), b"                ".into())
                    .encrypt_padded_vec_mut::<Pkcs7>(data),
            );
            v
        };
        assert_eq!(
            decrypt(&encrypt(b"short"), Some(&key), "host", 23).as_deref(),
            Some("short")
        );
        let mut data = Sha256::digest(b"host").to_vec();
        data.extend(b"cookie");
        assert_eq!(
            decrypt(&encrypt(&data), Some(&key), "host", 24).as_deref(),
            Some("cookie")
        );
        assert!(decrypt(&encrypt(&data), Some(&key), "other", 24).is_none());
        assert!(decrypt(b"v20unknown", Some(&key), "host", 24).is_none());
        assert!(decrypt(&encrypt(&data), None, "host", 24).is_none());
    }
    #[test]
    fn discovery_uses_profile_names_and_both_cookie_layouts() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Default/Network")).unwrap();
        std::fs::write(dir.path().join("Default/Network/Cookies"), "").unwrap();
        std::fs::write(
            dir.path().join("Local State"),
            r#"{"profile":{"info_cache":{"Default":{"name":"Work"}}}}"#,
        )
        .unwrap();
        let p = profiles_at("Chrome", dir.path());
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].name, "Work");
    }
}
