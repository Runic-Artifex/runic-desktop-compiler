//! Promise state (docs/design/M4-EFFECTS.md, "Promises and async functions").
//!
//! A promise stores its outcome or its pending reactions; it never runs
//! anything itself. Settling returns the jobs of its reactions, and adding a
//! reaction to a settled promise returns its job, so the owner of the
//! microtask queue (the reference interpreter or a generated app) queues
//! them in order. `J` is that owner's job type.

use crate::{JsResult, Throw};
use std::cell::RefCell;
use std::rc::Rc;

/// A reaction: given the outcome, the job that runs its handler.
pub type Reaction<T, J> = Box<dyn FnOnce(JsResult<T>) -> J>;

enum State<T, J> {
    Pending(Vec<Reaction<T, J>>),
    Settled(JsResult<T>),
}

/// A promise; equality is identity.
pub struct JsPromise<T, J>(Rc<RefCell<State<T, J>>>);

impl<T: Clone, J> JsPromise<T, J> {
    pub fn pending() -> Self {
        JsPromise(Rc::new(RefCell::new(State::Pending(Vec::new()))))
    }

    pub fn fulfilled(value: T) -> Self {
        JsPromise(Rc::new(RefCell::new(State::Settled(Ok(value)))))
    }

    pub fn rejected(reason: Throw) -> Self {
        JsPromise(Rc::new(RefCell::new(State::Settled(Err(reason)))))
    }

    /// Fulfil or reject; the jobs of the reactions, in registration order.
    /// A settled promise stays as it is (no jobs).
    pub fn settle(&self, outcome: JsResult<T>) -> Vec<J> {
        let mut state = self.0.borrow_mut();
        if matches!(*state, State::Settled(_)) {
            return Vec::new();
        }
        let State::Pending(reactions) =
            std::mem::replace(&mut *state, State::Settled(outcome.clone()))
        else {
            unreachable!("pending")
        };
        drop(state);
        reactions.into_iter().map(|r| r(outcome.clone())).collect()
    }

    /// Register a reaction; when the promise is settled already, its job is
    /// returned to be queued now.
    pub fn react(&self, reaction: Reaction<T, J>) -> Option<J> {
        let mut state = self.0.borrow_mut();
        match &mut *state {
            State::Pending(reactions) => {
                reactions.push(reaction);
                None
            }
            State::Settled(outcome) => {
                let outcome = outcome.clone();
                drop(state);
                Some(reaction(outcome))
            }
        }
    }

    /// The outcome, once settled.
    pub fn outcome(&self) -> Option<JsResult<T>> {
        match &*self.0.borrow() {
            State::Settled(o) => Some(o.clone()),
            State::Pending(_) => None,
        }
    }

    /// Stable identity for hashing (SameValueZero keys).
    pub fn addr(&self) -> usize {
        Rc::as_ptr(&self.0) as *const u8 as usize
    }

    pub fn ptr_eq(a: &Self, b: &Self) -> bool {
        Rc::ptr_eq(&a.0, &b.0)
    }
}

impl<T, J> Clone for JsPromise<T, J> {
    fn clone(&self) -> Self {
        JsPromise(Rc::clone(&self.0))
    }
}

impl<T, J> PartialEq for JsPromise<T, J> {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl<T, J> std::fmt::Debug for JsPromise<T, J> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match &*self.0.borrow() {
            State::Pending(_) => "Promise { <pending> }",
            State::Settled(Ok(_)) => "Promise { <fulfilled> }",
            State::Settled(Err(_)) => "Promise { <rejected> }",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reactions_run_in_order_once() {
        let p: JsPromise<f64, String> = JsPromise::pending();
        assert!(p.react(Box::new(|r| format!("a {:?}", r.ok()))).is_none());
        assert!(p.react(Box::new(|r| format!("b {:?}", r.ok()))).is_none());
        assert_eq!(p.settle(Ok(1.0)), vec!["a Some(1.0)", "b Some(1.0)"]);
        assert!(p.settle(Ok(2.0)).is_empty());
        assert_eq!(
            p.react(Box::new(|r| format!("c {:?}", r.ok()))),
            Some("c Some(1.0)".to_string())
        );
    }

    #[test]
    fn rejection_is_kept() {
        let p: JsPromise<f64, bool> = JsPromise::pending();
        p.settle(Err(Throw::new("Error", "x")));
        assert_eq!(p.react(Box::new(|r| r.is_err())), Some(true));
    }
}
