use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use base64::Engine;
use fv_core::{ImagePart, ImageSource, Message};

use crate::StoreError;

/// Pictures tools returned, as files: `tool-images/<conversation>/<id>.<ext>`.
///
/// A transcript line holds the path, not the bytes. A conversation that has looked at a few
/// hundred screenshots would otherwise be tens of megabytes of base64 that every read of the
/// transcript has to get through.
pub struct ImageStore {
    dir: PathBuf,
}

fn extension(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "bin",
    }
}

impl ImageStore {
    pub fn new(dir: PathBuf) -> Result<Self, StoreError> {
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(Self { dir })
    }

    fn folder(&self, conversation_id: &str) -> PathBuf {
        let safe: String = conversation_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        self.dir.join(safe)
    }

    /// Write the picture's bytes to a file and return the part that points at it.
    pub fn save(&self, conversation_id: &str, image: &ImagePart) -> Result<ImagePart, StoreError> {
        let ImageSource::Base64 { data } = &image.source else {
            return Ok(image.clone());
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| StoreError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
        let folder = self.folder(conversation_id);
        std::fs::create_dir_all(&folder)?;
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700))?;
        let path = folder.join(format!(
            "{}.{}",
            uuid::Uuid::new_v4(),
            extension(&image.mime)
        ));
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(&bytes)?;
        Ok(ImagePart {
            mime: image.mime.clone(),
            source: ImageSource::File {
                path: path.display().to_string(),
            },
        })
    }

    /// The message as it is written to the transcript: its pictures as files.
    pub fn externalize(
        &self,
        conversation_id: &str,
        message: &Message,
    ) -> Result<Message, StoreError> {
        match message {
            Message::ToolImages {
                call_id,
                name,
                images,
            } => Ok(Message::ToolImages {
                call_id: call_id.clone(),
                name: name.clone(),
                images: images
                    .iter()
                    .map(|i| self.save(conversation_id, i))
                    .collect::<Result<_, _>>()?,
            }),
            other => Ok(other.clone()),
        }
    }

    pub fn delete(&self, conversation_id: &str) -> Result<(), StoreError> {
        match std::fs::remove_dir_all(self.folder(conversation_id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}
