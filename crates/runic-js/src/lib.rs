//! JavaScript value semantics for generated Runic applications and the
//! reference interpreter (docs/design/M2-VALUES.md). Every function matches
//! ECMAScript for its documented domain; tests compare against Node.

mod attrs;
mod classes;
mod collections;
mod element;
mod error;
mod event;
mod heap;
mod keys;
mod media;
mod number;
mod promise;
mod string;
mod value;

pub mod array_ops;
pub mod date;
pub mod env;
pub mod history;
pub mod intl;
pub mod json;
pub mod random;
pub mod regexp;
pub mod reorder;
pub mod string_ops;
pub mod tz;
pub mod uri;

pub use array_ops::join_elements;
pub use attrs::{
    ATTACHMENT, AttrValue, Attrs, BOOLEAN_PROPERTIES, MergeKind, MergeOps, attachment_key,
    attrs_merge, class_merge, merge_props, resolve_entries,
};
pub use classes::{class_compose, class_toggle};
pub use collections::*;
pub use date::Date;
pub use element::Element;
pub use error::*;
pub use event::{Event, EventData};
pub use heap::*;
pub use keys::{KeySpec, MODIFIER_KEYS, parse_key_spec};
pub use media::MediaQueryList;
pub use number::*;
pub use promise::{JsPromise, Reaction};
pub use regexp::RegExp;
pub use string::JsString;
pub use value::*;
