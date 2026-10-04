//! `MediaQueryList` objects (`matchMedia(query)`): identity, the query and
//! the matches state its `change` events report against. Evaluation is the
//! host's (`runic_css::media_matches`); this holds the state.

use std::cell::Cell;
use std::rc::Rc;

#[derive(Debug)]
struct Inner {
    query: String,
    /// Creation order (change events go to lists oldest first).
    order: u64,
    /// The matches state when the list was created or last notified.
    matches: Cell<bool>,
}

/// A `MediaQueryList`, compared by identity.
#[derive(Clone, Debug)]
pub struct MediaQueryList(Rc<Inner>);

thread_local! {
    static NEXT: Cell<u64> = const { Cell::new(0) };
}

impl MediaQueryList {
    /// A new list for `query`, which matches now as given.
    pub fn new(query: &str, matches: bool) -> Self {
        let order = NEXT.with(|n| {
            let o = n.get();
            n.set(o + 1);
            o
        });
        MediaQueryList(Rc::new(Inner {
            query: query.to_owned(),
            order,
            matches: Cell::new(matches),
        }))
    }

    pub fn query(&self) -> &str {
        &self.0.query
    }

    pub fn order(&self) -> u64 {
        self.0.order
    }

    /// Record the current matches state: whether it changed since the list
    /// was created or last notified (a `change` event is due).
    pub fn update(&self, matches: bool) -> bool {
        self.0.matches.replace(matches) != matches
    }

    /// A key identifying the list (identity).
    pub fn id(&self) -> usize {
        Rc::as_ptr(&self.0) as usize
    }
}

impl PartialEq for MediaQueryList {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

use crate::{
    ArrayElement, JsString, MapKey, StrictEq, ToJsString, ToMapKey, ToNumber, Truthy, TypeOf,
};

impl ToJsString for MediaQueryList {
    fn to_js_string(&self) -> JsString {
        JsString::from("[object MediaQueryList]")
    }
}
impl Truthy for MediaQueryList {
    fn truthy(&self) -> bool {
        true
    }
}
impl ArrayElement for MediaQueryList {
    fn join_string(&self) -> JsString {
        self.to_js_string()
    }
}
impl ToNumber for MediaQueryList {
    fn to_number(&self) -> f64 {
        f64::NAN
    }
}
impl TypeOf for MediaQueryList {
    fn type_of(&self) -> &'static str {
        "object"
    }
}
impl StrictEq for MediaQueryList {
    fn strict_eq(&self, other: &Self) -> bool {
        self == other
    }
}
impl ToMapKey for MediaQueryList {
    fn map_key(&self) -> MapKey {
        MapKey::Ref(self.id())
    }
}
impl crate::Own for MediaQueryList {}
