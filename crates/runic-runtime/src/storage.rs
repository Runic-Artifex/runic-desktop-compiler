//! `localStorage` (docs/design/M4-EFFECTS.md): string items in insertion
//! order, persisted per app in the platform data directory and written after
//! every change. Probes keep it in memory, seeded by the case.

use runic_js::JsString;
use std::cell::RefCell;
use std::path::PathBuf;

thread_local! {
    /// Items a probe starts with (`--storage`); `Some` keeps storage in memory.
    static SEED: RefCell<Option<Vec<(JsString, JsString)>>> = const { RefCell::new(None) };
}

/// Start probes with these items in memory instead of the app's file.
pub fn seed(items: Vec<(JsString, JsString)>) {
    SEED.with(|s| *s.borrow_mut() = Some(items));
}

pub struct Storage {
    items: Vec<(JsString, JsString)>,
    path: Option<PathBuf>,
}

/// The items of a probe's in-memory storage (kept for a `reload`).
pub fn seeded() -> Option<Vec<(JsString, JsString)>> {
    SEED.with(|s| s.borrow().clone())
}

impl Storage {
    /// The storage of the app named `app` (its file, or a probe's seed).
    pub fn open(app: &str) -> Self {
        if let Some(items) = SEED.with(|s| s.borrow().clone()) {
            return Storage { items, path: None };
        }
        let path = data_dir().map(|d| {
            d.join("runic")
                .join(file_name(app))
                .join("localStorage.json")
        });
        let items = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<(Vec<u16>, Vec<u16>)>>(&bytes).ok())
            .map(|items| {
                items
                    .into_iter()
                    .map(|(k, v)| (JsString::from_units(k), JsString::from_units(v)))
                    .collect()
            })
            .unwrap_or_default();
        Storage { items, path }
    }

    pub fn get(&self, key: &JsString) -> Option<JsString> {
        self.items
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }

    pub fn set(&mut self, key: JsString, value: JsString) {
        match self.items.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) if *v == value => return,
            Some((_, v)) => *v = value,
            None => self.items.push((key, value)),
        }
        self.persist();
    }

    pub fn remove(&mut self, key: &JsString) {
        let n = self.items.len();
        self.items.retain(|(k, _)| k != key);
        if self.items.len() != n {
            self.persist();
        }
    }

    pub fn clear(&mut self) {
        if !self.items.is_empty() {
            self.items.clear();
            self.persist();
        }
    }

    /// Write the items (as UTF-16 code units, so any string survives); a
    /// probe keeps them for the next app instance (`reload`).
    fn persist(&self) {
        let Some(path) = &self.path else {
            SEED.with(|s| *s.borrow_mut() = Some(self.items.clone()));
            return;
        };
        let items: Vec<(Vec<u16>, Vec<u16>)> = self
            .items
            .iter()
            .map(|(k, v)| (k.units().to_vec(), v.units().to_vec()))
            .collect();
        let written = path
            .parent()
            .map(std::fs::create_dir_all)
            .transpose()
            .and_then(|_| std::fs::write(path, serde_json::to_vec(&items).expect("items")));
        if let Err(e) = written {
            eprintln!("runic: localStorage not saved to {}: {e}", path.display());
        }
    }
}

fn data_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
}

/// A directory name for the app title.
fn file_name(app: &str) -> String {
    let name: String = app
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if name.is_empty() { "app".into() } else { name }
}
