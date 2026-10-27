//! A private document server for a native WebView. It serves exactly one granted
//! document/media handle, never a path supplied by the page or a workspace directory.
//! Bodies are copied in 64 KiB chunks so video/PDF ranges never hydrate a whole file.
use std::{
    fs::File,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    ops::RangeInclusive,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

pub const HTML_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; connect-src https:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const MEDIA_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; object-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub enum Document {
    Html(String),
    Media { file: File, mime: String },
}
impl Document {
    pub fn media(path: &str, mime: &str) -> io::Result<Self> {
        if !mime
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/.-+".contains(&c))
            || !(mime.starts_with("image/")
                || mime.starts_with("video/")
                || mime.starts_with("audio/")
                || mime == "application/pdf")
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "不支持的媒体格式",
            ));
        }
        let file = File::open(path)?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "不是文件"));
        }
        Ok(Self::Media {
            file,
            mime: mime.into(),
        })
    }
}

pub struct DocumentServer {
    pub url: String,
    stop: Arc<AtomicBool>,
}
impl Drop for DocumentServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
impl DocumentServer {
    pub fn start(document: Document) -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let origin = format!("http://{}", listener.local_addr()?);
        let token = uuid::Uuid::new_v4().to_string();
        let route = format!("/{token}/");
        let url = format!("{origin}{route}");
        let data = Arc::new(document);
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled = stop.clone();
        let active = Arc::new(AtomicUsize::new(0));
        std::thread::Builder::new()
            .name("fv-document".into())
            .spawn(move || {
                while !cancelled.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((socket, _)) => {
                            if active.fetch_add(1, Ordering::AcqRel) >= 8 {
                                active.fetch_sub(1, Ordering::AcqRel);
                                drop(socket);
                                continue;
                            }
                            let (data, route, active, cancelled, origin) = (
                                data.clone(),
                                route.clone(),
                                active.clone(),
                                cancelled.clone(),
                                origin.clone(),
                            );
                            let worker_count = active.clone();
                            if std::thread::Builder::new()
                                .name("fv-document-read".into())
                                .spawn(move || {
                                    let _ = serve(socket, &data, &route, &origin, &cancelled);
                                    worker_count.fetch_sub(1, Ordering::AcqRel);
                                })
                                .is_err()
                            {
                                active.fetch_sub(1, Ordering::AcqRel);
                            }
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(20))
                        }
                        Err(_) => break,
                    }
                }
            })?;
        Ok(Self { url, stop })
    }
}

/// RFC 9110's single byte range. Multi-range is explicitly refused; WebKit's media
/// requests use single ranges. The inclusive end is clamped to the current file size.
fn byte_range(value: Option<&str>, len: u64) -> Result<Option<RangeInclusive<u64>>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    let (start, end) = value
        .strip_prefix("bytes=")
        .ok_or(())?
        .split_once('-')
        .ok_or(())?;
    if len == 0 || end.contains(',') {
        return Err(());
    }
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok(Some(len.saturating_sub(suffix)..=len - 1));
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    let end = if end.is_empty() {
        len - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(len - 1)
    };
    if start >= len || end < start {
        return Err(());
    }
    Ok(Some(start..=end))
}
fn response(
    socket: &mut TcpStream,
    status: &str,
    mime: &str,
    len: u64,
    csp: &str,
    extra: &str,
) -> io::Result<()> {
    write!(
        socket,
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {len}\r\nContent-Security-Policy: {csp}\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nConnection: close\r\n{extra}\r\n"
    )
}
fn serve(
    mut socket: TcpStream,
    data: &Document,
    route: &str,
    origin: &str,
    stop: &AtomicBool,
) -> io::Result<()> {
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 2048];
    loop {
        let n = socket.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        raw.extend_from_slice(&buf[..n]);
        if raw.len() > 16384 {
            return response(
                &mut socket,
                "431 Request Header Fields Too Large",
                "text/plain",
                0,
                HTML_CSP,
                "",
            );
        }
        if raw.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8_lossy(&raw);
    let mut lines = request.lines();
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("");
    let path = first.next().unwrap_or("");
    let headers = lines
        .filter_map(|l| {
            l.split_once(':')
                .map(|(k, v)| (k.to_ascii_lowercase(), v.trim()))
        })
        .collect::<Vec<_>>();
    let header = |key: &str| headers.iter().find(|(k, _)| k == key).map(|(_, v)| *v);
    let expected_host = origin.strip_prefix("http://").unwrap();
    if header("host") != Some(expected_host)
        || !(path == route || path == format!("{route}file"))
        || header("origin").is_some_and(|o| o != origin)
    {
        return response(&mut socket, "404 Not Found", "text/plain", 0, HTML_CSP, "");
    }
    if method != "GET" && method != "HEAD" {
        return response(
            &mut socket,
            "405 Method Not Allowed",
            "text/plain",
            0,
            HTML_CSP,
            "Allow: GET, HEAD\r\n",
        );
    }
    let html = match data {
        Document::Html(text) if path == route => Some(text.clone()),
        Document::Media { mime, .. } if path == route && mime != "application/pdf" => {
            let media = if mime.starts_with("image/") {
                String::from(
                    "<img src=\"file\" alt=\"预览\" style=\"max-width:100%;max-height:100%;object-fit:contain\">",
                )
            } else if mime.starts_with("audio/") {
                String::from("<audio controls src=\"file\"></audio>")
            } else {
                String::from(
                    "<video controls playsinline src=\"file\" style=\"width:100%;height:100%;object-fit:contain\"></video>",
                )
            };
            Some(format!(
                "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>预览</title><body style=\"margin:0;background:#171717;color:white;height:100vh;display:flex;align-items:center;justify-content:center\">{media}</body>"
            ))
        }
        _ => None,
    };
    if let Some(html) = html {
        let csp = if matches!(data, Document::Html(_)) {
            HTML_CSP
        } else {
            MEDIA_CSP
        };
        response(
            &mut socket,
            "200 OK",
            "text/html; charset=utf-8",
            html.len() as u64,
            csp,
            "",
        )?;
        if method != "HEAD" && !stop.load(Ordering::Acquire) {
            socket.write_all(html.as_bytes())?;
        }
        return Ok(());
    }
    let Document::Media { file, mime } = data else {
        return response(&mut socket, "404 Not Found", "text/plain", 0, HTML_CSP, "");
    };
    let len = file.metadata()?.len();
    let range = match byte_range(header("range"), len) {
        Ok(r) => r,
        Err(()) => {
            return response(
                &mut socket,
                "416 Range Not Satisfiable",
                mime,
                0,
                MEDIA_CSP,
                &format!("Content-Range: bytes */{len}\r\nAccept-Ranges: bytes\r\n"),
            );
        }
    };
    let start = range.as_ref().map_or(0, |r| *r.start());
    let count = range.as_ref().map_or(len, |r| r.end() - r.start() + 1);
    let extra = range.as_ref().map_or_else(
        || "Accept-Ranges: bytes\r\n".into(),
        |r| {
            format!(
                "Accept-Ranges: bytes\r\nContent-Range: bytes {}-{}/{len}\r\n",
                r.start(),
                r.end()
            )
        },
    );
    response(
        &mut socket,
        if range.is_some() {
            "206 Partial Content"
        } else {
            "200 OK"
        },
        mime,
        count,
        MEDIA_CSP,
        &extra,
    )?;
    if method == "HEAD" {
        return Ok(());
    }
    let mut offset = start;
    let mut buffer = [0u8; 65536];
    while offset - start < count && !stop.load(Ordering::Acquire) {
        let length = (count - (offset - start)).min(buffer.len() as u64) as usize;
        #[cfg(unix)]
        let read = {
            use std::os::unix::fs::FileExt;
            file.read_at(&mut buffer[..length], offset)?
        };
        #[cfg(windows)]
        let read = {
            use std::os::windows::fs::FileExt;
            file.seek_read(&mut buffer[..length], offset)?
        };
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "文件在预览期间被改写",
            ));
        }
        socket.write_all(&buffer[..read])?;
        offset += read as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn get(server: &DocumentServer, path: &str, headers: &str) -> String {
        let url = url::Url::parse(&server.url).unwrap();
        let mut socket = TcpStream::connect(("127.0.0.1", url.port().unwrap())).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(
            socket,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{headers}\r\n",
            url.port().unwrap()
        )
        .unwrap();
        let mut body = String::new();
        socket.read_to_string(&mut body).unwrap();
        body
    }
    #[test]
    fn html_is_a_real_document_with_an_isolated_origin_and_no_workspace_routes() {
        let server = DocumentServer::start(Document::Html(
            "<script>document.title='works'</script>你好".into(),
        ))
        .unwrap();
        let path = url::Url::parse(&server.url).unwrap().path().to_string();
        let response = get(&server, &path, "");
        assert!(
            response.contains("200 OK") && response.contains("你好") && response.contains(HTML_CSP)
        );
        for bad in [
            "/",
            "/etc/passwd",
            &format!("{path}../secret"),
            &format!("{path}file"),
        ] {
            assert!(get(&server, bad, "").contains("404 Not Found"));
        }
        assert!(get(&server, &path, "Origin: https://evil.example\r\n").contains("404 Not Found"));
    }
    #[test]
    fn media_ranges_are_real_bytes_and_never_follow_a_replaced_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        std::fs::write(&path, b"0123456789").unwrap();
        let server =
            DocumentServer::start(Document::media(path.to_str().unwrap(), "video/mp4").unwrap())
                .unwrap();
        std::fs::rename(&path, dir.path().join("original")).unwrap();
        std::fs::write(&path, b"secret").unwrap();
        let route = format!("{}file", url::Url::parse(&server.url).unwrap().path());
        let response = get(&server, &route, "Range: bytes=3-6\r\n");
        assert!(
            response.contains("206 Partial Content")
                && response.contains("Content-Range: bytes 3-6/10")
                && response.ends_with("3456")
        );
        assert!(get(&server, &route, "Range: bytes=-2\r\n").ends_with("89"));
        assert!(get(&server, &route, "Range: bytes=10-\r\n").contains("416 Range Not Satisfiable"));
    }
    #[test]
    fn range_bounds_cover_empty_suffix_open_ended_and_multiple_requests() {
        assert_eq!(byte_range(None, 0), Ok(None));
        assert_eq!(byte_range(Some("bytes=2-999"), 10), Ok(Some(2..=9)));
        assert_eq!(byte_range(Some("bytes=-999"), 10), Ok(Some(0..=9)));
        for value in [
            "bytes=-0",
            "bytes=1-0",
            "bytes=0-1,4-5",
            "bytes=0-",
            "bytes=999999999999999999999999999-1",
        ] {
            assert!(byte_range(Some(value), 0).is_err());
        }
    }
}

#[cfg(test)]
mod streaming_tests {
    use super::*;
    fn request(
        server: &DocumentServer,
        method: &str,
        path: &str,
        extra: &str,
    ) -> (String, Vec<u8>) {
        let url = url::Url::parse(&server.url).unwrap();
        let mut socket = TcpStream::connect(("127.0.0.1", url.port().unwrap())).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(
            socket,
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{extra}\r\n",
            url.port().unwrap()
        )
        .unwrap();
        let mut bytes = Vec::new();
        socket.read_to_end(&mut bytes).unwrap();
        let at = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        (
            String::from_utf8(bytes[..at].to_vec()).unwrap(),
            bytes[at..].to_vec(),
        )
    }
    #[test]
    fn sparse_large_media_head_and_concurrent_ranges_do_not_load_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.mp4");
        let file = File::create(&path).unwrap();
        file.set_len(256 * 1024 * 1024).unwrap();
        drop(file);
        let server =
            DocumentServer::start(Document::media(path.to_str().unwrap(), "video/mp4").unwrap())
                .unwrap();
        let url = url::Url::parse(&server.url).unwrap();
        let route = format!("{}file", url.path());
        let (head, body) = request(&server, "HEAD", &route, "");
        assert!(head.contains("Content-Length: 268435456"));
        assert!(body.is_empty());
        std::thread::scope(|scope| {
            let a =
                scope.spawn(|| request(&server, "GET", &route, "Range: bytes=1048576-1048581\r\n"));
            let b = scope.spawn(|| request(&server, "GET", &route, "Range: bytes=-7\r\n"));
            assert_eq!(a.join().unwrap().1, vec![0; 6]);
            assert_eq!(b.join().unwrap().1, vec![0; 7]);
        });
        assert!(
            request(&server, "POST", url.path(), "")
                .0
                .contains("405 Method Not Allowed")
        );
        assert!(Document::media(path.to_str().unwrap(), "video/mp4\r\nX-Test: x").is_err());
    }
    #[test]
    fn dropping_the_document_revokes_its_listener_and_file_grant() {
        let server = DocumentServer::start(Document::Html("page".into())).unwrap();
        let url = url::Url::parse(&server.url).unwrap();
        let addr = ("127.0.0.1", url.port().unwrap());
        drop(server);
        let until = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if TcpStream::connect(addr).is_err() {
                break;
            }
            assert!(
                std::time::Instant::now() < until,
                "preview listener survived its view"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
