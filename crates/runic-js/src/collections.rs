//! `Map` and `Set`: insertion-ordered, keyed by SameValueZero.

use crate::{JsRef, JsString, Maybe};
use indexmap::IndexMap;

/// A SameValueZero key: NaN equals NaN, +0 equals -0, references by identity.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum MapKey {
    Undefined,
    Null,
    Bool(bool),
    Num(u64),
    Str(JsString),
    Ref(usize),
}

pub trait ToMapKey {
    fn map_key(&self) -> MapKey;
}
impl ToMapKey for f64 {
    fn map_key(&self) -> MapKey {
        let x = if self.is_nan() {
            f64::NAN
        } else if *self == 0.0 {
            0.0
        } else {
            *self
        };
        MapKey::Num(x.to_bits())
    }
}
impl ToMapKey for bool {
    fn map_key(&self) -> MapKey {
        MapKey::Bool(*self)
    }
}
impl ToMapKey for JsString {
    fn map_key(&self) -> MapKey {
        MapKey::Str(self.clone())
    }
}
impl<T> ToMapKey for JsRef<T> {
    fn map_key(&self) -> MapKey {
        MapKey::Ref(self.addr())
    }
}
impl<T: ToMapKey> ToMapKey for Maybe<T> {
    fn map_key(&self) -> MapKey {
        match self {
            Maybe::Some(v) => v.map_key(),
            Maybe::Null => MapKey::Null,
            Maybe::Undefined => MapKey::Undefined,
        }
    }
}

#[derive(Clone, Debug)]
pub struct MapData<K, V> {
    pub entries: IndexMap<MapKey, (K, V)>,
}

impl<K, V> Default for MapData<K, V> {
    fn default() -> Self {
        MapData {
            entries: IndexMap::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SetData<T> {
    pub entries: IndexMap<MapKey, T>,
}

impl<T> Default for SetData<T> {
    fn default() -> Self {
        SetData {
            entries: IndexMap::new(),
        }
    }
}

pub type JsMap<K, V> = JsRef<MapData<K, V>>;
pub type JsSet<T> = JsRef<SetData<T>>;

// Maps and sets are never proxied (Svelte requires SvelteMap/SvelteSet).
impl<K, V> crate::OwnFields for MapData<K, V> {
    const PROXIED: bool = false;
}
impl<T> crate::OwnFields for SetData<T> {
    const PROXIED: bool = false;
}
