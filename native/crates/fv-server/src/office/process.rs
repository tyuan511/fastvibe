use fv_env::OfficeInstall;
use std::{collections::BTreeMap, ffi::OsString, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
};
use tokio_util::sync::CancellationToken;
pub(super) struct Process {
    pub child: Child,
    pid: Option<u32>,
}
impl Process {
    pub async fn stop(mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid.take() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }
}
pub(super) fn environment(install: &OfficeInstall, data: &Path) -> BTreeMap<OsString, OsString> {
    let mut env = fv_env::snapshot();
    install.apply(&mut env, data);
    env
}
pub(super) fn spawn(
    install: &OfficeInstall,
    data: &Path,
    args: &[OsString],
) -> Result<Process, String> {
    std::fs::create_dir_all(data.join("officecli-state"))
        .map_err(|e| format!("无法创建文档运行目录：{e}"))?;
    let mut cmd = Command::new(&install.binary);
    cmd.args(args)
        .envs(environment(install, data))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let child = cmd
        .spawn()
        .map_err(|e| format!("无法启动内置 OfficeCLI：{e}"))?;
    let pid = child.id();
    Ok(Process { child, pid })
}
pub(super) async fn drain(reader: impl AsyncRead + Unpin, limit: usize) -> (Vec<u8>, bool) {
    let mut reader = reader;
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut overflow = false;
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let take = n.min(limit.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&buffer[..take]);
                overflow |= take < n;
            }
        }
    }
    (bytes, overflow)
}
pub(super) async fn run(
    install: &OfficeInstall,
    data: &Path,
    args: &[OsString],
    cancel: &CancellationToken,
    deadline: Duration,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let mut process = spawn(install, data, args)?;
    let out = tokio::spawn(drain(
        process.child.stdout.take().unwrap(),
        if limit == 0 { 4000 } else { limit },
    ));
    let err = tokio::spawn(drain(process.child.stderr.take().unwrap(), 4000));
    let result = tokio::select! {
        biased;
        _=cancel.cancelled()=>Err("文档操作已取消".into()),
        _=tokio::time::sleep(deadline)=>Err("文档操作超时".into()),
        status=process.child.wait()=>status.map_err(|e|e.to_string()),
    };
    // Kill descendants before joining their inherited output pipes, even on a normal exit.
    process.stop().await;
    let stdout = out.await.unwrap_or_default();
    let stderr = err.await.unwrap_or_default();
    match result {
        Err(e) => Err(e),
        Ok(status) if !status.success() => Err(format!(
            "文档操作失败：{}",
            if !stderr.0.is_empty() {
                String::from_utf8_lossy(&stderr.0).trim().to_string()
            } else if !stdout.0.is_empty() {
                String::from_utf8_lossy(&stdout.0).trim().to_string()
            } else {
                status.to_string()
            }
        )),
        Ok(_) if stdout.1 && limit > 0 => Err("文档操作输出过大".into()),
        Ok(_) => Ok(stdout.0),
    }
}
