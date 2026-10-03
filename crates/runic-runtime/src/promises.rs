//! Promise operations for generated apps, with ECMAScript's job ordering
//! (docs/design/M4-EFFECTS.md). The reference interpreter implements the same
//! jobs over its dynamic values; the differential test compares the two.

use runic_js::{JsArray, JsPromise, JsResult, Reaction, Throw};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// A microtask of a generated app.
pub type Task<C> = Rc<dyn Fn(&mut C) -> JsResult<()>>;

/// The generated app's context: queues microtasks.
pub trait Microtasks: Sized + 'static {
    fn queue_microtask(&mut self, job: Task<Self>);
}

pub type Promise<T, C> = JsPromise<T, Task<C>>;

/// A handler's result: a value, or a promise the derived promise adopts.
pub enum Settles<T, C> {
    Value(T),
    Promise(Promise<T, C>),
}

pub type Handler<A, T, C> = Rc<dyn Fn(&mut C, A) -> JsResult<Settles<T, C>>>;

fn queue_all<C: Microtasks>(cx: &mut C, jobs: Vec<Task<C>>) {
    for j in jobs {
        cx.queue_microtask(j);
    }
}

pub fn settle<T: Clone + 'static, C: Microtasks>(
    cx: &mut C,
    p: &Promise<T, C>,
    outcome: JsResult<T>,
) {
    let jobs = p.settle(outcome);
    queue_all(cx, jobs);
}

/// A reaction that settles `target` with the outcome (adoption and missing handlers).
fn pass_on<T: Clone + 'static, C: Microtasks>(target: Promise<T, C>) -> Reaction<T, Task<C>> {
    Box::new(move |outcome| {
        let target = target.clone();
        Rc::new(move |cx: &mut C| {
            settle(cx, &target, outcome.clone());
            Ok(())
        })
    })
}

fn react<T: Clone + 'static, C: Microtasks>(
    cx: &mut C,
    p: &Promise<T, C>,
    reaction: Reaction<T, Task<C>>,
) {
    if let Some(job) = p.react(reaction) {
        cx.queue_microtask(job);
    }
}

/// Resolve `p` with a handler's result: a value fulfils, a promise is
/// adopted (one job to subscribe, one for its reaction).
pub fn resolve<T: Clone + 'static, C: Microtasks>(
    cx: &mut C,
    p: &Promise<T, C>,
    result: Settles<T, C>,
) {
    match result {
        Settles::Value(v) => settle(cx, p, Ok(v)),
        Settles::Promise(q) if q == *p => settle(
            cx,
            p,
            Err(Throw::new(
                "TypeError",
                "Chaining cycle detected for promise",
            )),
        ),
        Settles::Promise(q) => {
            let p = p.clone();
            cx.queue_microtask(Rc::new(move |cx: &mut C| {
                react(cx, &q, pass_on(p.clone()));
                Ok(())
            }));
        }
    }
}

/// `new Promise(executor)`: the resolve and reject functions (only the first
/// call of either counts).
#[allow(clippy::type_complexity)]
pub fn resolvers<T: Clone + 'static, C: Microtasks>(
    p: &Promise<T, C>,
) -> (
    Rc<dyn Fn(&mut C, T) -> JsResult<()>>,
    Rc<dyn Fn(&mut C, Throw) -> JsResult<()>>,
) {
    let done = Rc::new(Cell::new(false));
    let (p1, d1) = (p.clone(), done.clone());
    let resolve = Rc::new(move |cx: &mut C, v: T| {
        if !d1.replace(true) {
            settle(cx, &p1, Ok(v));
        }
        Ok(())
    });
    let (p2, d2) = (p.clone(), done);
    let reject = Rc::new(move |cx: &mut C, t: Throw| {
        if !d2.replace(true) {
            settle(cx, &p2, Err(t));
        }
        Ok(())
    });
    (resolve, reject)
}

/// Run `executor(resolve, reject)`; an exception rejects (unless settled).
pub fn new<T: Clone + 'static, C: Microtasks>(
    cx: &mut C,
    executor: impl FnOnce(
        &mut C,
        Rc<dyn Fn(&mut C, T) -> JsResult<()>>,
        Rc<dyn Fn(&mut C, Throw) -> JsResult<()>>,
    ) -> JsResult<()>,
) -> Promise<T, C> {
    let p = Promise::pending();
    let (resolve, reject) = resolvers(&p);
    if let Err(t) = executor(cx, resolve, reject.clone()) {
        let _ = reject(cx, t);
    }
    p
}

/// `p.then(onFulfilled, onRejected?)`.
pub fn then<T: Clone + 'static, U: Clone + 'static, C: Microtasks>(
    cx: &mut C,
    p: &Promise<T, C>,
    on_fulfilled: Handler<T, U, C>,
    on_rejected: Option<Handler<Throw, U, C>>,
) -> Promise<U, C> {
    let derived = Promise::pending();
    let target = derived.clone();
    react(
        cx,
        p,
        Box::new(move |outcome: JsResult<T>| {
            let (on_fulfilled, on_rejected, target) =
                (on_fulfilled.clone(), on_rejected.clone(), target.clone());
            Rc::new(move |cx: &mut C| {
                let result = match (outcome.clone(), &on_rejected) {
                    (Ok(v), _) => on_fulfilled(cx, v),
                    (Err(t), Some(h)) => h(cx, t),
                    (Err(t), None) => Err(t),
                };
                match result {
                    Ok(r) => resolve(cx, &target, r),
                    Err(t) => settle(cx, &target, Err(t)),
                }
                Ok(())
            })
        }),
    );
    derived
}

/// `p.catch(onRejected)`; a fulfilment passes on through `map` (the identity,
/// or unreachable for a promise that never fulfils).
pub fn catch<T: Clone + 'static, U: Clone + 'static, C: Microtasks>(
    cx: &mut C,
    p: &Promise<T, C>,
    map: fn(T) -> U,
    on_rejected: Handler<Throw, U, C>,
) -> Promise<U, C> {
    let pass: Handler<T, U, C> = Rc::new(move |_, v| Ok(Settles::Value(map(v))));
    then(cx, p, pass, Some(on_rejected))
}

/// `p.finally(onFinally)`: the callback runs, then (after its result settles)
/// the original outcome passes on.
pub fn finally<T: Clone + 'static, X: Clone + 'static, C: Microtasks>(
    cx: &mut C,
    p: &Promise<T, C>,
    on_finally: Rc<dyn Fn(&mut C) -> JsResult<Settles<X, C>>>,
) -> Promise<T, C> {
    let after = move |cx: &mut C, outcome: JsResult<T>| -> JsResult<Settles<T, C>> {
        let r = on_finally(cx)?;
        let q: Promise<X, C> = match r {
            Settles::Value(x) => Promise::fulfilled(x),
            Settles::Promise(q) => q,
        };
        // q.then(() => outcome): one more reaction, then adoption.
        let thunk: Promise<T, C> = Promise::pending();
        let target = thunk.clone();
        react(
            cx,
            &q,
            Box::new(move |qo: JsResult<X>| {
                let (target, outcome) = (target.clone(), outcome.clone());
                Rc::new(move |cx: &mut C| {
                    let o = match &qo {
                        Ok(_) => outcome.clone(),
                        Err(t) => Err(t.clone()),
                    };
                    settle(cx, &target, o);
                    Ok(())
                })
            }),
        );
        Ok(Settles::Promise(thunk))
    };
    let after = Rc::new(after);
    let a2 = after.clone();
    then(
        cx,
        p,
        Rc::new(move |cx, v| after(cx, Ok(v))),
        Some(Rc::new(move |cx, t| a2(cx, Err(t)))),
    )
}

/// `Promise.all(items)`.
pub fn all<T: Clone + 'static, C: Microtasks>(
    cx: &mut C,
    items: &[Promise<T, C>],
) -> Promise<JsArray<T>, C> {
    let derived = Promise::pending();
    let values: Rc<RefCell<Vec<Option<T>>>> = Rc::new(RefCell::new(vec![None; items.len()]));
    let remaining = Rc::new(Cell::new(items.len()));
    if items.is_empty() {
        settle(cx, &derived, Ok(runic_js::array(Vec::new())));
    }
    for (i, item) in items.iter().enumerate() {
        let (values, remaining, target) = (values.clone(), remaining.clone(), derived.clone());
        react(
            cx,
            item,
            Box::new(move |outcome: JsResult<T>| {
                let (values, remaining, target) =
                    (values.clone(), remaining.clone(), target.clone());
                Rc::new(move |cx: &mut C| {
                    match outcome.clone() {
                        Ok(v) => {
                            values.borrow_mut()[i] = Some(v);
                            remaining.set(remaining.get() - 1);
                            if remaining.get() == 0 {
                                let all: Vec<T> = values
                                    .borrow()
                                    .iter()
                                    .cloned()
                                    .map(Option::unwrap)
                                    .collect();
                                settle(cx, &target, Ok(runic_js::array(all)));
                            }
                        }
                        Err(t) => settle(cx, &target, Err(t)),
                    }
                    Ok(())
                })
            }),
        );
    }
    derived
}
