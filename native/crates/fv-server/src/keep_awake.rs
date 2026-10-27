use std::sync::Mutex;

pub struct KeepAwake {
    child: Mutex<Option<std::process::Child>>,
}

impl KeepAwake {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    pub fn set(&self, enabled: bool) {
        let mut child = self.child.lock().unwrap();
        if !enabled {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
            return;
        }
        if child
            .as_mut()
            .is_some_and(|process| process.try_wait().ok().flatten().is_none())
        {
            return;
        }
        *child = None;
        #[cfg(target_os = "macos")]
        {
            *child = std::process::Command::new("caffeinate")
                .args(["-dimsu"])
                .spawn()
                .ok();
        }
    }
}

impl Default for KeepAwake {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        if let Some(mut process) = self.child.get_mut().unwrap().take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}
