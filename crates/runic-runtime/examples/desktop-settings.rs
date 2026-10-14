//! Test desktop for the desktop preferences (conformance/desktop-preferences.mjs).
//!
//! - `read <ms>`: prints the runtime's reading (`runic_runtime::desktop`) as a
//!   JSON line, then each change for `ms` milliseconds.
//! - `xsettings`: an XSETTINGS manager on `$DISPLAY`. Each stdin line is a
//!   JSON array of `[name, type, value]` settings (`int`, `string`,
//!   `color`), published as the manager's property, or `"release"`, which
//!   destroys the manager window. Prints `ready` after each line.
//! - `portal`: an `org.freedesktop.portal.Settings` service
//!   (`org.freedesktop.portal.Desktop`) on the session bus. Each stdin line is
//!   a JSON object of namespaces to keys to values (booleans, strings,
//!   numbers as `u32`), replacing the settings and signalling each changed
//!   key. Prints `ready` after each line.

use std::io::BufRead;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("read") => read(args.get(1).and_then(|a| a.parse().ok()).unwrap_or(0)),
        #[cfg(target_os = "linux")]
        Some("xsettings") => linux::xsettings(),
        #[cfg(target_os = "linux")]
        Some("portal") => linux::portal(),
        _ => {
            eprintln!("usage: desktop-settings read <ms> | xsettings | portal");
            std::process::exit(2);
        }
    }
}

fn json(prefs: &runic_runtime::desktop::Preferences) -> String {
    let reading = |r: runic_runtime::desktop::Reading| match r {
        Ok(b) => serde_json::json!(b),
        Err(reason) => serde_json::json!({ "unknown": reason }),
    };
    serde_json::json!({
        "reducedMotion": reading(prefs.reduced_motion),
        "contrastMore": reading(prefs.contrast_more),
    })
    .to_string()
}

fn read(follow_ms: u64) {
    runic_runtime::desktop::start();
    runic_runtime::desktop::wait();
    let mut last = runic_runtime::desktop::current();
    println!("{}", json(&last));
    let end = std::time::Instant::now() + std::time::Duration::from_millis(follow_ms);
    while std::time::Instant::now() < end {
        std::thread::sleep(std::time::Duration::from_millis(10));
        let now = runic_runtime::desktop::current();
        if now != last {
            println!("{}", json(&now));
            last = now;
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::BufRead;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        ClientMessageEvent, ConnectionExt as _, CreateWindowAux, EventMask, PropMode, WindowClass,
    };
    use x11rb::wrapper::ConnectionExt as _;
    use zbus::zvariant::{OwnedValue, Value};

    fn property(entries: &[serde_json::Value], serial: u32) -> Vec<u8> {
        let mut out = vec![0u8, 0, 0, 0];
        out.extend(serial.to_le_bytes());
        out.extend((entries.len() as u32).to_le_bytes());
        let pad = |b: &mut Vec<u8>| {
            while b.len() % 4 != 0 {
                b.push(0);
            }
        };
        for e in entries {
            let name = e[0].as_str().expect("name");
            let ty = e[1].as_str().expect("type");
            out.push(match ty {
                "int" => 0,
                "string" => 1,
                "color" => 2,
                _ => panic!("type {ty}"),
            });
            out.push(0);
            out.extend((name.len() as u16).to_le_bytes());
            out.extend(name.as_bytes());
            pad(&mut out);
            out.extend(0u32.to_le_bytes());
            match ty {
                "int" => out.extend((e[2].as_i64().expect("int") as i32).to_le_bytes()),
                "string" => {
                    let s = e[2].as_str().expect("string");
                    out.extend((s.len() as u32).to_le_bytes());
                    out.extend(s.as_bytes());
                    pad(&mut out);
                }
                _ => out.extend([0u8; 8]),
            }
        }
        out
    }

    pub(super) fn xsettings() {
        let (conn, screen) = x11rb::connect(None).expect("X display");
        let root = conn.setup().roots[screen].root;
        let atom = |n: &str| {
            conn.intern_atom(false, n.as_bytes())
                .unwrap()
                .reply()
                .unwrap()
                .atom
        };
        let selection = atom(&format!("_XSETTINGS_S{screen}"));
        let prop = atom("_XSETTINGS_SETTINGS");
        let manager = atom("MANAGER");
        let mut window = None;
        let mut serial = 0;
        for line in std::io::stdin().lock().lines() {
            let line = line.expect("stdin");
            let v: serde_json::Value = serde_json::from_str(&line).expect("json");
            if v == "release" {
                if let Some(w) = window.take() {
                    conn.destroy_window(w).unwrap();
                }
            } else {
                let w = match window {
                    Some(w) => w,
                    None => {
                        let w = conn.generate_id().unwrap();
                        conn.create_window(
                            0,
                            w,
                            root,
                            -1,
                            -1,
                            1,
                            1,
                            0,
                            WindowClass::INPUT_ONLY,
                            0,
                            &CreateWindowAux::new(),
                        )
                        .unwrap();
                        window = Some(w);
                        w
                    }
                };
                serial += 1;
                let data = property(v.as_array().expect("array"), serial);
                conn.change_property8(PropMode::REPLACE, w, prop, prop, &data)
                    .unwrap();
                if serial == 1
                    || conn
                        .get_selection_owner(selection)
                        .unwrap()
                        .reply()
                        .unwrap()
                        .owner
                        != w
                {
                    conn.set_selection_owner(w, selection, x11rb::CURRENT_TIME)
                        .unwrap();
                    let event = ClientMessageEvent::new(
                        32,
                        root,
                        manager,
                        [x11rb::CURRENT_TIME, selection, w, 0, 0],
                    );
                    conn.send_event(false, root, EventMask::STRUCTURE_NOTIFY, event)
                        .unwrap();
                }
            }
            conn.sync().unwrap();
            println!("ready");
        }
    }

    type Settings = HashMap<String, HashMap<String, serde_json::Value>>;

    fn value(v: &serde_json::Value) -> OwnedValue {
        match v {
            serde_json::Value::Bool(b) => Value::from(*b).try_into().unwrap(),
            serde_json::Value::String(s) => Value::from(s.as_str()).try_into().unwrap(),
            serde_json::Value::Number(n) => {
                Value::from(n.as_u64().unwrap() as u32).try_into().unwrap()
            }
            _ => panic!("value {v}"),
        }
    }

    fn matches(ns: &str, patterns: &[String]) -> bool {
        patterns.is_empty()
            || patterns.iter().any(|p| match p.strip_suffix('*') {
                Some(prefix) => ns.starts_with(prefix),
                None => ns == p,
            })
    }

    struct Portal(Arc<Mutex<Settings>>);

    #[zbus::interface(name = "org.freedesktop.portal.Settings")]
    impl Portal {
        fn read_all(
            &self,
            namespaces: Vec<String>,
        ) -> HashMap<String, HashMap<String, OwnedValue>> {
            let s = self.0.lock().unwrap();
            s.iter()
                .filter(|(ns, _)| matches(ns, &namespaces))
                .map(|(ns, keys)| {
                    (
                        ns.clone(),
                        keys.iter().map(|(k, v)| (k.clone(), value(v))).collect(),
                    )
                })
                .collect()
        }

        fn read_one(&self, namespace: String, key: String) -> zbus::fdo::Result<OwnedValue> {
            let s = self.0.lock().unwrap();
            s.get(&namespace)
                .and_then(|k| k.get(&key))
                .map(value)
                .ok_or_else(|| zbus::fdo::Error::Failed("Requested setting not found".into()))
        }

        #[zbus(signal)]
        async fn setting_changed(
            emitter: &zbus::object_server::SignalEmitter<'_>,
            namespace: &str,
            key: &str,
            value: Value<'_>,
        ) -> zbus::Result<()>;

        #[zbus(property, name = "version")]
        fn version(&self) -> u32 {
            2
        }
    }

    pub(super) fn portal() {
        let settings: Arc<Mutex<Settings>> = Arc::default();
        let path = "/org/freedesktop/portal/desktop";
        let conn = zbus::blocking::connection::Builder::session()
            .unwrap()
            .name("org.freedesktop.portal.Desktop")
            .unwrap()
            .serve_at(path, Portal(settings.clone()))
            .unwrap()
            .build()
            .expect("session bus");
        let iface = conn
            .object_server()
            .interface::<_, Portal>(path)
            .expect("interface");
        for line in std::io::stdin().lock().lines() {
            let line = line.expect("stdin");
            let next: Settings = serde_json::from_str(&line).expect("json");
            let old = std::mem::replace(&mut *settings.lock().unwrap(), next.clone());
            for (ns, keys) in &next {
                for (k, v) in keys {
                    if old.get(ns).and_then(|o| o.get(k)) != Some(v) {
                        let v = value(v);
                        zbus::block_on(Portal::setting_changed(
                            iface.signal_emitter(),
                            ns,
                            k,
                            Value::from(v),
                        ))
                        .unwrap();
                    }
                }
            }
            println!("ready");
        }
    }
}
