//! Promise state (docs/design/M4-EFFECTS.md, "Promises and async functions").
//!
//! A promise stores its outcome or its pending reactions; it never runs
//! anything itself. Settling returns the jobs of its reactions, and adding a
//! reaction to a settled promise returns its job, so the owner of the
//! microtask queue (the reference interpreter or a generated app) queues
//! them in order. `J` is that owner's job type.
//!
//! Unhandled rejections (M6) are tracked as ECMAScript's
//! HostPromiseRejectionTracker and HTML's "notify about rejected promises"
//! describe them, with Chromium's timing (docs/IR.md, promises): a promise
//! rejected while no reaction was ever added to it joins the pending list;
//! at the end of each microtask checkpoint the owner takes the list
//! (`take_rejections`) into a report task, which reports those still
//! without a reaction when it runs (`Rejections::report`).

use crate::{JsResult, JsString, Throw};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// A reaction: given the outcome, the job that runs its handler.
pub type Reaction<T, J> = Box<dyn FnOnce(JsResult<T>) -> J>;

enum State<T, J> {
    Pending(Vec<Reaction<T, J>>),
    Settled(JsResult<T>),
}

/// Whether a promise has a reaction (`[[PromiseIsHandled]]`) and whether
/// its rejection was reported as unhandled.
#[derive(Default)]
struct Track {
    handled: Cell<bool>,
    reported: Cell<bool>,
}

struct Inner<T, J> {
    state: RefCell<State<T, J>>,
    track: Rc<Track>,
}

thread_local! {
    /// Promises rejected without a reaction since the last checkpoint.
    static PENDING: RefCell<Vec<(Rc<Track>, Throw)>> = const { RefCell::new(Vec::new()) };
    /// A reaction added to a promise whose rejection was reported (Chromium
    /// revokes the report: not modelled).
    static LATE: RefCell<Option<Throw>> = const { RefCell::new(None) };
}

/// Rejections taken at the end of a microtask checkpoint, reported by a
/// later task.
pub struct Rejections(Vec<(Rc<Track>, Throw)>);

impl Rejections {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The reasons of the promises still without a reaction, in rejection
    /// order, marked reported.
    pub fn report(self) -> Vec<Throw> {
        self.0
            .into_iter()
            .filter(|(t, _)| !t.handled.get())
            .map(|(t, reason)| {
                t.reported.set(true);
                reason
            })
            .collect()
    }
}

/// The promises rejected without a reaction since the last call (HTML's
/// about-to-be-notified rejected promises list).
pub fn take_rejections() -> Rejections {
    Rejections(PENDING.with(|p| std::mem::take(&mut *p.borrow_mut())))
}

/// The reason of a rejection that was reported as unhandled and got a
/// reaction since, if any (since the last call).
pub fn take_late_handled() -> Option<Throw> {
    LATE.with(|l| l.borrow_mut().take())
}

/// Forgets pending rejections (a new app instance).
pub fn clear_rejections() {
    PENDING.with(|p| p.borrow_mut().clear());
    LATE.with(|l| *l.borrow_mut() = None);
}

/// Chromium's console text of an unhandled rejection with `reason`: the
/// report's prefix and the error's first stack line (`Error: message`).
pub fn rejection_line(reason: &Throw) -> JsString {
    JsString::from(format!("Uncaught (in promise) {reason}"))
}

/// A promise; equality is identity.
pub struct JsPromise<T, J>(Rc<Inner<T, J>>);

impl<T: Clone, J> JsPromise<T, J> {
    fn with_state(state: State<T, J>) -> Self {
        JsPromise(Rc::new(Inner {
            state: RefCell::new(state),
            track: Rc::default(),
        }))
    }

    pub fn pending() -> Self {
        Self::with_state(State::Pending(Vec::new()))
    }

    pub fn fulfilled(value: T) -> Self {
        Self::with_state(State::Settled(Ok(value)))
    }

    /// `Promise.reject(reason)`: rejected, so far without a reaction.
    pub fn rejected(reason: Throw) -> Self {
        let p = Self::with_state(State::Settled(Err(reason.clone())));
        p.track_rejection(reason);
        p
    }

    /// Marks the promise handled without a reaction, as platform promises
    /// whose rejections are never reported (an Animation's `finished`).
    pub fn mark_handled(&self) {
        self.0.track.handled.set(true);
    }

    fn track_rejection(&self, reason: Throw) {
        if !self.0.track.handled.get() {
            PENDING.with(|p| p.borrow_mut().push((Rc::clone(&self.0.track), reason)));
        }
    }

    /// Fulfil or reject; the jobs of the reactions, in registration order.
    /// A settled promise stays as it is (no jobs).
    pub fn settle(&self, outcome: JsResult<T>) -> Vec<J> {
        let mut state = self.0.state.borrow_mut();
        if matches!(*state, State::Settled(_)) {
            return Vec::new();
        }
        let State::Pending(reactions) =
            std::mem::replace(&mut *state, State::Settled(outcome.clone()))
        else {
            unreachable!("pending")
        };
        drop(state);
        if let Err(reason) = &outcome {
            self.track_rejection(reason.clone());
        }
        reactions.into_iter().map(|r| r(outcome.clone())).collect()
    }

    /// Register a reaction; when the promise is settled already, its job is
    /// returned to be queued now.
    pub fn react(&self, reaction: Reaction<T, J>) -> Option<J> {
        let track = &self.0.track;
        if !track.handled.replace(true) && track.reported.get() {
            if let State::Settled(Err(reason)) = &*self.0.state.borrow() {
                LATE.with(|l| *l.borrow_mut() = Some(reason.clone()));
            }
        }
        let mut state = self.0.state.borrow_mut();
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
        match &*self.0.state.borrow() {
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

/// A promise held by state stays as it is (no proxy).
impl<T, J> crate::Own for JsPromise<T, J> {}

impl<T, J> PartialEq for JsPromise<T, J> {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl<T, J> std::fmt::Debug for JsPromise<T, J> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match &*self.0.state.borrow() {
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
    fn unhandled_rejections_are_reported_once() {
        clear_rejections();
        let a: JsPromise<f64, bool> = JsPromise::pending();
        let b: JsPromise<f64, bool> = JsPromise::rejected(Throw::new("TypeError", "b"));
        let handled: JsPromise<f64, bool> = JsPromise::pending();
        handled.react(Box::new(|r| r.is_err()));
        a.settle(Err(Throw::new("Error", "")));
        handled.settle(Err(Throw::new("Error", "handled")));
        let batch = take_rejections();
        // A reaction before the report task runs: not reported.
        b.react(Box::new(|r| r.is_err()));
        let reported: Vec<String> = batch
            .report()
            .iter()
            .map(rejection_line)
            .map(|s| s.to_rust())
            .collect();
        assert_eq!(reported, ["Uncaught (in promise) Error"]);
        assert!(take_rejections().is_empty());
        assert!(take_late_handled().is_none());
        // A reaction after the report.
        a.react(Box::new(|r| r.is_err()));
        assert_eq!(take_late_handled(), Some(Throw::new("Error", "")));
    }

    #[test]
    fn rejection_is_kept() {
        let p: JsPromise<f64, bool> = JsPromise::pending();
        p.settle(Err(Throw::new("Error", "x")));
        assert_eq!(p.react(Box::new(|r| r.is_err())), Some(true));
    }
}
