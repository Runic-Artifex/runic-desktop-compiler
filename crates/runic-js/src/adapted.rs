//! Converted function values (IR `fn.adapted`, docs/IR.md): a function
//! converted to a compatible function type gives the same converted value
//! for the same function and maker while that value is alive, as JavaScript
//! passes the same function.
//!
//! Entries are keyed by the maker function and the address of the original
//! function's allocation, and hold the converted value weakly. The key is
//! sound because a converted value holds its original function strongly
//! (the adapter closure captures it): while an entry's value is alive, the
//! original is too, so its address cannot be freed and reused by another
//! function. An entry whose value has died says nothing (a lookup misses and
//! the next conversion replaces it); such entries are swept when the map has
//! doubled since the last sweep, so converting many short-lived functions
//! does not grow it without bound.

use std::any::Any;
use std::collections::HashMap;
use std::rc::{Rc, Weak};

/// A weakly held converted value of some type.
trait Entry {
    fn alive(&self) -> bool;
    fn as_any(&self) -> &dyn Any;
}

impl<U: ?Sized + 'static> Entry for Weak<U> {
    fn alive(&self) -> bool {
        self.strong_count() > 0
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// The converted values of a program (`Cx::adapted`).
pub struct Adapted {
    map: HashMap<(usize, usize), Box<dyn Entry>>,
    /// The size at which the next insertion sweeps dead entries.
    sweep_at: usize,
}

impl Default for Adapted {
    fn default() -> Self {
        Adapted {
            map: HashMap::new(),
            sweep_at: Self::MIN_SWEEP,
        }
    }
}

impl Adapted {
    const MIN_SWEEP: usize = 64;

    fn key<S: ?Sized>(maker: usize, f: &Rc<S>) -> (usize, usize) {
        (maker, Rc::as_ptr(f) as *const () as usize)
    }

    /// The value `maker` converted `f` to, if it is still alive.
    pub fn get<U: ?Sized + 'static, S: ?Sized>(&self, maker: usize, f: &Rc<S>) -> Option<Rc<U>> {
        self.map
            .get(&Self::key(maker, f))
            .and_then(|e| e.as_any().downcast_ref::<Weak<U>>())
            .and_then(Weak::upgrade)
    }

    /// Records `v` as the value `maker` converted `f` to. `v` must hold `f`
    /// (module docs).
    pub fn insert<U: ?Sized + 'static, S: ?Sized>(&mut self, maker: usize, f: &Rc<S>, v: &Rc<U>) {
        if self.map.len() >= self.sweep_at {
            self.map.retain(|_, e| e.alive());
            self.sweep_at = (2 * self.map.len()).max(Self::MIN_SWEEP);
        }
        self.map
            .insert(Self::key(maker, f), Box::new(Rc::downgrade(v)));
    }

    /// The number of entries, dead ones included (tests).
    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type F = dyn Fn() -> i32;

    /// A converted value holding `f`, as the generated adapter does.
    fn convert(cache: &mut Adapted, maker: usize, f: &Rc<F>) -> Rc<F> {
        if let Some(v) = cache.get::<F, F>(maker, f) {
            return v;
        }
        let inner = Rc::clone(f);
        let v: Rc<F> = Rc::new(move || inner() + 1);
        cache.insert(maker, f, &v);
        v
    }

    #[test]
    fn same_function_same_value_while_alive() {
        let mut cache = Adapted::default();
        let f: Rc<F> = Rc::new(|| 1);
        let a = convert(&mut cache, 7, &f);
        let b = convert(&mut cache, 7, &f);
        assert!(Rc::ptr_eq(&a, &b));
        assert_eq!(a(), 2);
        // Another maker converts it to another value.
        let c = convert(&mut cache, 8, &f);
        assert!(!Rc::ptr_eq(&a, &c));
        // Another function, another value.
        let g: Rc<F> = Rc::new(|| 10);
        let d = convert(&mut cache, 7, &g);
        assert!(!Rc::ptr_eq(&a, &d));
        assert_eq!(d(), 11);
    }

    #[test]
    fn a_new_function_at_a_reused_address_gets_a_new_value() {
        let mut cache = Adapted::default();
        for round in 0..100 {
            let f: Rc<F> = Rc::new(move || round);
            let address = Rc::as_ptr(&f) as *const () as usize;
            let a = convert(&mut cache, 1, &f);
            assert_eq!(a(), round + 1);
            // While the converted value lives, it holds f: f's address
            // cannot be reused.
            drop(f);
            drop(a);
            // Both are freed: a new function (often at the same address)
            // converts to a new value of its own.
            let g: Rc<F> = Rc::new(move || 1000 + round);
            let reused = Rc::as_ptr(&g) as *const () as usize == address;
            let b = convert(&mut cache, 1, &g);
            assert_eq!(b(), 1001 + round, "round {round}, address reused: {reused}");
        }
    }

    #[test]
    fn dead_entries_are_swept_when_the_map_doubles() {
        let mut cache = Adapted::default();
        // Keep the functions alive (distinct addresses), drop the values.
        let fs: Vec<Rc<F>> = (0..10_000).map(|i| Rc::new(move || i) as Rc<F>).collect();
        for f in &fs {
            drop(convert(&mut cache, 3, f));
        }
        assert!(
            cache.len() <= 2 * Adapted::MIN_SWEEP,
            "{} entries",
            cache.len()
        );
        // Live values are kept across sweeps.
        let live: Vec<Rc<F>> = fs
            .iter()
            .take(100)
            .map(|f| convert(&mut cache, 4, f))
            .collect();
        for f in &fs[100..] {
            drop(convert(&mut cache, 3, f));
        }
        for (f, v) in fs.iter().zip(&live) {
            assert!(Rc::ptr_eq(&convert(&mut cache, 4, f), v));
        }
        assert!(
            cache.len() <= 2 * (100 + Adapted::MIN_SWEEP),
            "{} entries",
            cache.len()
        );
    }
}
