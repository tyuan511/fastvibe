use crate::ServerState;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use fv_protocol::{
    ErrorObject,
    jsonrpc::code,
    remote::{FileChunk, ReadFileParams},
};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

pub fn read(state: &ServerState, params: ReadFileParams) -> Result<FileChunk, ErrorObject> {
    let invalid = |message: &str| ErrorObject::new(code::INVALID_PARAMS, message);
    if params.length > 512 * 1024 {
        return Err(invalid("file slices cannot exceed 512 KiB"));
    }
    let path = if Path::new(&params.path).is_absolute() {
        std::path::PathBuf::from(&params.path)
    } else {
        let thread = state
            .thread(&params.thread_id)?
            .ok_or_else(|| invalid("thread not found"))?;
        let cwd = thread
            .cwd
            .ok_or_else(|| invalid("thread has no working directory"))?;
        Path::new(&cwd).join(&params.path)
    };
    let mut file = std::fs::File::open(path).map_err(|error| invalid(&error.to_string()))?;
    let metadata = file
        .metadata()
        .map_err(|error| invalid(&error.to_string()))?;
    if !metadata.is_file() {
        return Err(invalid("path is not a file"));
    }
    let size = metadata.len();
    if size > 256 * 1024 * 1024 {
        return Err(invalid("file exceeds 256 MiB download limit"));
    }
    if params.offset > size {
        return Err(invalid("offset is past end of file"));
    }
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64);
    file.seek(SeekFrom::Start(params.offset))
        .map_err(|error| invalid(&error.to_string()))?;
    let mut bytes = vec![0; u64::from(params.length).min(size - params.offset) as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| invalid(&error.to_string()))?;
    let eof = params.offset + bytes.len() as u64 >= size;
    Ok(FileChunk {
        size,
        mtime_ms,
        offset: params.offset,
        data: STANDARD.encode(bytes),
        eof,
    })
}
