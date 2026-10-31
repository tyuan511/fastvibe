//! Native-only Bonjour advertisement, owned by the authenticated LAN listener.
//! Construction opens no sockets. A stopped listener has no multicast daemon either.
use std::{collections::HashMap, io, net::IpAddr, path::Path};

use mdns_sd::{ServiceDaemon, ServiceInfo};

pub const SERVICE_TYPE: &str = "_fastvibe-native._tcp.local.";
pub const DEFAULT_NAME: &str = "FastVibe Native";

#[derive(Clone, Debug, PartialEq, Eq)]
struct Advertisement {
    name: String,
    hostname: String,
    id: String,
    port: u16,
    addresses: Vec<IpAddr>,
}

impl Advertisement {
    fn service(&self) -> Result<ServiceInfo, mdns_sd::Error> {
        let properties = HashMap::from([
            ("v".to_owned(), "1".to_owned()),
            ("transport".to_owned(), "fv-protocol".to_owned()),
            (
                "protocolVersion".to_owned(),
                fv_protocol::PROTOCOL_VERSION.to_string(),
            ),
            ("id".to_owned(), self.id.clone()),
        ]);
        ServiceInfo::new(
            SERVICE_TYPE,
            &self.name,
            &self.hostname,
            self.addresses.as_slice(),
            self.port,
            properties,
        )
    }
}

trait Publisher: Send {
    fn publish(&mut self, advertisement: &Advertisement) -> Result<(), String>;
    fn stop(&mut self);
    #[cfg(test)]
    fn diagnostics(&self) -> Vec<String> {
        Vec::new()
    }
}

#[derive(Default)]
struct Bonjour {
    running: Option<(ServiceDaemon, String)>,
    #[cfg(test)]
    monitor: Option<mdns_sd::Receiver<mdns_sd::DaemonEvent>>,
}
impl Publisher for Bonjour {
    fn publish(&mut self, advertisement: &Advertisement) -> Result<(), String> {
        let service = advertisement.service().map_err(|e| e.to_string())?;
        let fullname = service.get_fullname().to_owned();
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        #[cfg(test)]
        {
            self.monitor = Some(daemon.monitor().map_err(|e| e.to_string())?);
        }
        if let Err(error) = daemon.register(service) {
            let _ = daemon.shutdown();
            return Err(error.to_string());
        }
        // mdns-sd probes and renames conflicting instance names rather than claiming the
        // system's hostname. Do not enable automatic addresses: Android NSD exposes only
        // one address, so an unrequested fe80:: record could hide a reachable IPv4 host.
        self.running = Some((daemon, fullname));
        Ok(())
    }
    #[cfg(test)]
    fn diagnostics(&self) -> Vec<String> {
        self.monitor
            .as_ref()
            .map(|monitor| {
                monitor
                    .try_iter()
                    .map(|event| format!("{event:?}"))
                    .collect()
            })
            .unwrap_or_default()
    }
    fn stop(&mut self) {
        #[cfg(test)]
        {
            self.monitor = None;
        }
        if let Some((daemon, fullname)) = self.running.take() {
            if let Ok(done) = daemon.unregister(&fullname) {
                let _ = done.recv_timeout(std::time::Duration::from_millis(500));
            }
            if let Ok(done) = daemon.shutdown() {
                let _ = done.recv_timeout(std::time::Duration::from_millis(500));
            }
        }
    }
}

pub struct RemoteDiscovery {
    id: String,
    publisher: Box<dyn Publisher>,
    current: Option<Advertisement>,
}
impl RemoteDiscovery {
    pub fn new(data_dir: &Path) -> io::Result<Self> {
        Ok(Self {
            id: install_id(data_dir)?,
            publisher: Box::<Bonjour>::default(),
            current: None,
        })
    }
    pub fn install_id(&self) -> &str {
        &self.id
    }

    /// The caller supplies actual listening origins, never a configured wildcard bind.
    /// Disabled, passwordless or addressless states tear down even an existing daemon.
    pub fn sync(
        &mut self,
        listening: bool,
        password_configured: bool,
        port: u16,
        name: &str,
        origins: &[String],
    ) -> Result<(), String> {
        let addresses = advertised_addresses(origins);
        let desired = (listening && password_configured && port != 0 && !addresses.is_empty())
            .then(|| Advertisement {
                name: instance_name(name),
                hostname: format!("fastvibe-native-{}.local.", self.id),
                id: self.id.clone(),
                port,
                addresses,
            });
        if self.current == desired {
            return Ok(());
        }
        self.stop();
        if let Some(advertisement) = desired {
            self.publisher.publish(&advertisement)?;
            self.current = Some(advertisement);
        }
        Ok(())
    }
    pub fn stop(&mut self) {
        self.publisher.stop();
        self.current = None;
    }
}
impl Drop for RemoteDiscovery {
    fn drop(&mut self) {
        self.stop();
    }
}

fn install_id(data_dir: &Path) -> io::Result<String> {
    let path = data_dir.join("native-discovery-id");
    let read = || -> io::Result<String> {
        let value = std::fs::read_to_string(&path)?;
        uuid::Uuid::parse_str(value.trim())
            .map(|id| id.to_string())
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    };
    match read() {
        Ok(id) => return Ok(id),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    use std::io::Write;
    let id = uuid::Uuid::new_v4().to_string();
    let mut temporary = tempfile::NamedTempFile::new_in(data_dir)?;
    temporary.write_all(id.as_bytes())?;
    match temporary.persist_noclobber(&path) {
        Ok(_) => Ok(id),
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => read(),
        Err(error) => Err(error.error),
    }
}

/// The instance label is UTF-8 byte bounded; the independent SRV target never changes.
pub fn instance_name(name: &str) -> String {
    let clean: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_control() || c == '.' || c == '\\' {
                '-'
            } else {
                c
            }
        })
        .collect();
    let clean = if clean.is_empty() {
        DEFAULT_NAME
    } else {
        &clean
    };
    let mut end = clean.len().min(63);
    while !clean.is_char_boundary(end) {
        end -= 1;
    }
    clean[..end].to_owned()
}

fn advertised_addresses(origins: &[String]) -> Vec<IpAddr> {
    let mut addresses: Vec<_> = origins
        .iter()
        .filter_map(|origin| {
            let host_port = origin.strip_prefix("http://")?;
            if let Some(v6) = host_port.strip_prefix('[') {
                v6.split(']').next()?.parse::<IpAddr>().ok()
            } else {
                host_port.rsplit_once(':')?.0.parse::<IpAddr>().ok()
            }
        })
        .filter(|ip| match ip {
            IpAddr::V4(ip) => {
                !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_link_local()
                    && !ip.is_multicast()
                    && !ip.is_broadcast()
            }
            IpAddr::V6(ip) => {
                !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_unicast_link_local()
                    && !ip.is_multicast()
            }
        })
        .collect();
    if addresses.iter().any(IpAddr::is_ipv4) {
        addresses.retain(IpAddr::is_ipv4);
    }
    addresses.sort();
    addresses.dedup();
    addresses
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    #[derive(Default)]
    struct Calls {
        publications: Vec<Advertisement>,
        stops: usize,
    }
    struct Fake(Arc<Mutex<Calls>>);
    impl Publisher for Fake {
        fn publish(&mut self, a: &Advertisement) -> Result<(), String> {
            self.0.lock().unwrap().publications.push(a.clone());
            Ok(())
        }
        fn stop(&mut self) {
            self.0.lock().unwrap().stops += 1;
        }
    }
    #[test]
    fn lifecycle_is_listener_gated_and_replaces_name_port_and_family() {
        let calls = Arc::new(Mutex::new(Calls::default()));
        let mut discovery = RemoteDiscovery {
            id: uuid::Uuid::new_v4().to_string(),
            publisher: Box::new(Fake(calls.clone())),
            current: None,
        };
        let v4 = vec![
            "http://192.168.1.2:7777".into(),
            "http://[fe80::1]:7777".into(),
            "http://[2001:db8::1]:7777".into(),
        ];
        discovery.sync(false, true, 7777, "Computer", &v4).unwrap();
        discovery.sync(true, false, 7777, "Computer", &v4).unwrap();
        assert!(calls.lock().unwrap().publications.is_empty());
        discovery.sync(true, true, 7777, "Computer", &v4).unwrap();
        discovery.sync(true, true, 7777, "Computer", &v4).unwrap();
        assert_eq!(calls.lock().unwrap().publications.len(), 1);
        discovery.sync(true, true, 7777, "Renamed", &v4).unwrap();
        discovery.sync(true, true, 8888, "Renamed", &v4).unwrap();
        discovery
            .sync(
                true,
                true,
                8888,
                "Renamed",
                &["http://[2001:db8::1]:8888".into()],
            )
            .unwrap();
        let c = calls.lock().unwrap();
        assert_eq!(c.publications.len(), 4);
        assert!(c.publications[0].addresses.iter().all(IpAddr::is_ipv4));
        assert!(c.publications[3].addresses.iter().all(IpAddr::is_ipv6));
        assert_eq!(c.publications[0].hostname, c.publications[3].hostname);
        let service = c.publications[0].service().unwrap();
        assert_eq!(service.get_type(), SERVICE_TYPE);
        assert_eq!(
            service.get_property_val_str("transport"),
            Some("fv-protocol")
        );
        assert_eq!(service.get_properties().len(), 4);
        drop(c);
        discovery.sync(false, true, 8888, "Renamed", &v4).unwrap();
        assert!(discovery.current.is_none());
        assert_eq!(calls.lock().unwrap().stops, 5);
    }
    /// Opt-in: real multicast on existing interfaces, no router or user configuration changes.
    /// Run with `cargo test -p fv-server real_mdns_publication --lib -- --ignored --nocapture`.
    #[test]
    #[ignore = "opens real mDNS multicast sockets; requires an active LAN interface"]
    fn real_mdns_publication_rename_and_withdrawal() {
        use mdns_sd::ServiceEvent;
        use std::{
            collections::HashSet,
            time::{Duration, Instant},
        };
        struct Browser(ServiceDaemon);
        impl Drop for Browser {
            fn drop(&mut self) {
                let _ = self.0.stop_browse(SERVICE_TYPE);
                if let Ok(done) = self.0.shutdown() {
                    let _ = done.recv_timeout(Duration::from_millis(500));
                }
            }
        }
        let deadline = Instant::now() + Duration::from_secs(9);
        let directory = tempfile::tempdir().unwrap();
        let mut discovery = RemoteDiscovery::new(directory.path()).unwrap();
        let id = discovery.install_id().to_owned();
        let name = format!("FV-test-{id}");
        let renamed = format!("FV-renamed-{id}");
        // Reserve a real port, without exposing an HTTP listener.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let origins = crate::remote::interface_origins(port);
        let expected = advertised_addresses(&origins);
        assert!(
            !expected.is_empty(),
            "real mDNS test requires an active LAN interface"
        );
        let browser = Browser(ServiceDaemon::new().unwrap());
        let browser_monitor = browser.0.monitor().unwrap();
        let events = browser.0.browse(SERVICE_TYPE).unwrap();
        println!("mDNS usable origins: {origins:?}");
        let mut active = HashSet::new();
        let mut removed = HashSet::new();
        let mut initial = None;
        let mut replacement = None;
        let protocol_version = fv_protocol::PROTOCOL_VERSION.to_string();
        discovery.sync(true, true, port, &name, &origins).unwrap();
        let mut did_rename = false;
        let mut did_stop = false;
        let mut quiet_since = None;
        while Instant::now() < deadline {
            for diagnostic in discovery.publisher.diagnostics() {
                println!("publisher: {diagnostic}");
            }
            for diagnostic in browser_monitor.try_iter() {
                println!("browser: {diagnostic:?}");
            }
            if let Ok(event) = events.recv_timeout(Duration::from_millis(50)) {
                println!("browse event: {event:?}");
                match event {
                    ServiceEvent::ServiceResolved(service)
                        if service.get_property_val_str("id") == Some(id.as_str()) =>
                    {
                        assert_eq!(
                            service.get_property_val_str("transport"),
                            Some("fv-protocol")
                        );
                        assert_eq!(service.get_property_val_str("v"), Some("1"));
                        assert_eq!(
                            service.get_property_val_str("protocolVersion"),
                            Some(protocol_version.as_str())
                        );
                        assert_eq!(service.get_port(), port);
                        assert_eq!(
                            service.get_hostname(),
                            format!("fastvibe-native-{id}.local.")
                        );
                        assert!(!service.get_addresses().is_empty());
                        assert!(
                            service
                                .get_addresses()
                                .iter()
                                .all(|ip| ip.is_ipv4() == expected[0].is_ipv4())
                        );
                        assert!(
                            service
                                .get_addresses()
                                .iter()
                                .all(|ip| expected.contains(&ip.to_ip_addr()))
                        );
                        let fullname = service.get_fullname().to_owned();
                        active.insert(fullname.clone());
                        if fullname.starts_with(&format!("{name}.")) {
                            initial = Some(fullname);
                        } else if fullname.starts_with(&format!("{renamed}.")) {
                            replacement = Some(fullname);
                        } else {
                            panic!("unexpected test instance: {fullname}");
                        }
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        active.remove(&fullname);
                        removed.insert(fullname);
                    }
                    _ => {}
                }
            }
            if initial.is_some() && !did_rename {
                discovery
                    .sync(true, true, port, &renamed, &origins)
                    .unwrap();
                did_rename = true;
            }
            if replacement.is_some()
                && initial.as_ref().is_some_and(|old| removed.contains(old))
                && !did_stop
            {
                discovery.stop();
                did_stop = true;
            }
            if did_stop
                && active.is_empty()
                && replacement
                    .as_ref()
                    .is_some_and(|new| removed.contains(new))
            {
                let since = quiet_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= Duration::from_millis(300) {
                    println!(
                        "real mDNS publish/resolve/rename/withdraw PASS: family={} id={id}",
                        if expected[0].is_ipv4() {
                            "IPv4"
                        } else {
                            "IPv6"
                        }
                    );
                    return;
                }
            } else {
                quiet_since = None;
            }
        }
        panic!(
            "mDNS deadline: initial={initial:?}, renamed={replacement:?}, removed={removed:?}, active={active:?}"
        );
    }

    #[test]
    fn stable_install_identity_and_safe_unicode_label() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            install_id(dir.path()).unwrap(),
            install_id(dir.path()).unwrap()
        );
        assert_eq!(instance_name(" a.b\\c\n "), "a-b-c");
        let name = instance_name(&"电脑".repeat(50));
        assert!(name.len() <= 63);
        assert_eq!(instance_name(""), DEFAULT_NAME);
        assert!(
            advertised_addresses(&[
                "http://127.0.0.1:1".into(),
                "http://0.0.0.0:1".into(),
                "http://[fe80::1]:1".into()
            ])
            .is_empty()
        );
    }
}
