//! JavaScript value semantics for generated Runic applications and the
//! reference interpreter (docs/design/M2-VALUES.md). Every function matches
//! ECMAScript for its documented domain; tests compare against Node.

mod collections;
mod error;
mod heap;
mod number;
mod string;
mod value;

pub mod array_ops;
pub mod json;
pub mod string_ops;

pub use array_ops::join_elements;
pub use collections::*;
pub use error::*;
pub use heap::*;
pub use number::*;
pub use string::JsString;
pub use value::*;
