//! SSH uses the same reconnect supervisor as the local application, with a separate
//! runtime, current connection and request stream for every host window.
use super::*;

impl Backend {
    pub fn start_ssh(
        host: fv_daemon::ssh::SshHost,
    ) -> (
        impl Future<Output = Option<Backend>>,
        mpsc::UnboundedReceiver<BackendEvent>,
    ) {
        Self::start_with_connector(
            move || {
                let host = host.clone();
                async move {
                    fv_env::initialize().await;
                    host.connect_current(
                        "fastvibe-gui-ssh",
                        env!("CARGO_PKG_VERSION"),
                        fv_protocol::DESKTOP_REQUIRED_FEATURES,
                    )
                    .await
                }
            },
            RetryPolicy::default(),
        )
    }
}
