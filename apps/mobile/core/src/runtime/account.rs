use super::*;

impl CoreHandle {
    #[cfg(feature = "mobile-client")]
    pub(super) fn command_login_url(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let origin = required_string(value, "origin")?;
        let redirect_uri = required_string(value, "redirectUri")
            .or_else(|_| required_string(value, "redirect_uri"))?;
        let device_name = value
            .get("deviceName")
            .or_else(|| value.get("device_name"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("FastVibe Mobile");
        let platform = value
            .get("platform")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("mobile");
        let (client, verifier, state, url) =
            mobile_client::new_login_request(origin, redirect_uri, device_name, platform)
                .map_err(|error| error.to_string())?;
        *lock(&self.account) = Some(client);
        *lock(&self.login) = Some(LoginState {
            verifier: verifier.clone(),
            state: state.clone(),
        });
        Ok(
            serde_json::json!({"url": url, "state": state, "verifier": verifier, "redirectUri": redirect_uri}),
        )
    }

    #[cfg(not(feature = "mobile-client"))]
    pub(super) fn command_login_url(
        &self,
        _: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("mobile-client feature is disabled".into())
    }

    #[cfg(feature = "mobile-client")]
    pub(super) fn command_exchange_token(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let code = required_string(value, "code")?;
        let redirect_uri = required_string(value, "redirectUri")
            .or_else(|_| required_string(value, "redirect_uri"))?;
        let login_state = lock(&self.login);
        if let Some(callback_state) = value.get("state").and_then(serde_json::Value::as_str) {
            let expected_state = login_state
                .as_ref()
                .map(|login| login.state.as_str())
                .ok_or("loginUrl must be called first")?;
            if callback_state != expected_state {
                return Err("OAuth state mismatch".into());
            }
        }
        let stored_verifier = login_state.as_ref().map(|login| login.verifier.clone());
        drop(login_state);
        let verifier = value
            .get("verifier")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned)
            .or(stored_verifier)
            .ok_or("login verifier is required")?;
        let mut account = lock(&self.account);
        let client = account.as_mut().ok_or("loginUrl must be called first")?;
        let state = self
            .runtime
            .block_on(client.exchange(code, redirect_uri, &verifier));
        *lock(&self.login) = None;
        state
            .map(|state| serde_json::to_value(state).unwrap_or(serde_json::Value::Null))
            .map_err(|error| error.to_string())
    }

    #[cfg(not(feature = "mobile-client"))]
    pub(super) fn command_exchange_token(
        &self,
        _: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("mobile-client feature is disabled".into())
    }

    #[cfg(feature = "mobile-client")]
    pub(super) fn command_set_token(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let token = required_string(value, "token")?.to_owned();
        let origin = required_string(value, "origin")?;
        let mut client =
            mobile_client::AccountClient::new(origin).map_err(|error| error.to_string())?;
        client.token = Some(token);
        *lock(&self.account) = Some(client);
        Ok(serde_json::json!({"status": "token-set"}))
    }

    #[cfg(not(feature = "mobile-client"))]
    pub(super) fn command_set_token(
        &self,
        _: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("mobile-client feature is disabled".into())
    }

    #[cfg(feature = "iroh-transport")]
    pub(super) fn identity_key(&self) -> Result<iroh::SecretKey, String> {
        let mut identity = lock(&self.identity);
        let secret = match identity.as_deref() {
            Some(secret) => parse_secret_key(secret)?,
            None => {
                let secret = iroh::SecretKey::generate();
                *identity = Some(secret_key_string(&secret));
                secret.to_bytes()
            }
        };
        Ok(iroh::SecretKey::from_bytes(&secret))
    }

    #[cfg(feature = "iroh-transport")]
    pub(super) fn command_identity(&self) -> Result<serde_json::Value, String> {
        let secret = self.identity_key()?;
        let secret_string = secret_key_string(&secret);
        let endpoint_id = secret.public().to_string();
        lock(&self.shared.connection).endpoint_id = Some(endpoint_id.clone());
        Ok(serde_json::json!({"secretKey": secret_string, "endpointId": endpoint_id}))
    }

    #[cfg(not(feature = "iroh-transport"))]
    pub(super) fn command_identity(&self) -> Result<serde_json::Value, String> {
        Err("iroh-transport feature is disabled".into())
    }

    #[cfg(feature = "iroh-transport")]
    pub(super) fn command_set_identity(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let key = required_string(value, "secretKey")
            .or_else(|_| required_string(value, "secret_key"))?;
        let key = parse_secret_key(key)?;
        let secret = iroh::SecretKey::from_bytes(&key);
        let secret_string = secret_key_string(&secret);
        let endpoint_id = secret.public().to_string();
        *lock(&self.identity) = Some(secret_string.clone());
        lock(&self.shared.connection).endpoint_id = Some(endpoint_id.clone());
        Ok(serde_json::json!({"secretKey": secret_string, "endpointId": endpoint_id}))
    }

    #[cfg(not(feature = "iroh-transport"))]
    pub(super) fn command_set_identity(
        &self,
        _: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("iroh-transport feature is disabled".into())
    }

    #[cfg(feature = "mobile-client")]
    pub(super) fn command_register_endpoint(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let device_id =
            required_string(value, "deviceId").or_else(|_| required_string(value, "device_id"))?;
        let endpoint_id = required_string(value, "endpointId")
            .or_else(|_| required_string(value, "endpoint_id"))?;
        let account = lock(&self.account);
        let client = account.as_ref().ok_or("account is not signed in")?;
        self.runtime
            .block_on(client.register_endpoint(device_id, endpoint_id))
            .map_err(|error| error.to_string())?;
        lock(&self.shared.connection).endpoint_id = Some(endpoint_id.to_owned());
        Ok(
            serde_json::json!({"status": "registered", "deviceId": device_id, "endpointId": endpoint_id}),
        )
    }

    #[cfg(not(feature = "mobile-client"))]
    pub(super) fn command_register_endpoint(
        &self,
        _: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("mobile-client feature is disabled".into())
    }

    #[cfg(feature = "mobile-client")]
    pub(super) fn command_register_device(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let install_id = required_string(value, "installId")
            .or_else(|_| required_string(value, "install_id"))?;
        let name = value
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("FastVibe Mobile");
        let platform = value
            .get("platform")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("mobile");
        let account = lock(&self.account);
        let client = account.as_ref().ok_or("account is not signed in")?;
        let id = self
            .runtime
            .block_on(client.register_device(install_id, name, platform))
            .map_err(|error| error.to_string())?;
        lock(&self.shared.connection).device_id = Some(id.clone());
        Ok(serde_json::json!({"deviceId": id}))
    }

    #[cfg(not(feature = "mobile-client"))]
    pub(super) fn command_register_device(
        &self,
        _: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("mobile-client feature is disabled".into())
    }

    #[cfg(feature = "mobile-client")]
    pub(super) fn command_devices(&self) -> Result<serde_json::Value, String> {
        let account = lock(&self.account);
        let client = account.as_ref().ok_or("account is not signed in")?;
        let devices = self
            .runtime
            .block_on(client.devices())
            .map_err(|error| error.to_string())?;
        Ok(serde_json::to_value(devices).unwrap_or_else(|_| serde_json::json!([])))
    }

    #[cfg(not(feature = "mobile-client"))]
    pub(super) fn command_devices(&self) -> Result<serde_json::Value, String> {
        Err("mobile-client feature is disabled".into())
    }

    #[cfg(feature = "mobile-client")]
    pub(super) fn command_relay(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let device_id =
            required_string(value, "deviceId").or_else(|_| required_string(value, "device_id"))?;
        let endpoint_id = required_string(value, "endpointId")
            .or_else(|_| required_string(value, "endpoint_id"))?;
        let account = lock(&self.account);
        let client = account.as_ref().ok_or("account is not signed in")?;
        let relay = self
            .runtime
            .block_on(client.relay(device_id, endpoint_id))
            .map_err(|error| error.to_string())?;
        Ok(serde_json::to_value(relay).unwrap_or(serde_json::Value::Null))
    }

    #[cfg(not(feature = "mobile-client"))]
    pub(super) fn command_relay(&self, _: &serde_json::Value) -> Result<serde_json::Value, String> {
        Err("mobile-client feature is disabled".into())
    }
}
