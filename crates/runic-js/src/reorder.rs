//! Which blocks of a keyed list move during an update.
//!
//! All strategies produce the same final order, but they detach different
//! existing nodes, and a detached node loses focus in Chromium (and its
//! selection, scroll position, …). Each strategy reproduces one framework's
//! keyed diff exactly; the adapter selects it in the IR.
//!
//! Input: `old[j]` is the previous position of the block now at position `j`
//! (`None` for new blocks), `old_len` the previous number of blocks. Output:
//! for every `j`, whether a reused block keeps its DOM position (moved blocks
//! and new blocks are `false`).

/// The keyed reorder strategy of an `each` node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reorder {
    /// Common prefix and suffix stay; in the middle, a longest increasing
    /// subsequence of previous positions stays (Vue 3's `patchKeyedChildren`).
    Lis,
    /// A block moves when its previous position is below the highest one
    /// placed so far (React's `reconcileChildrenArray`).
    Forward,
    /// Svelte 5's `reconcile`: runs of out-of-place blocks are stashed and
    /// the shorter of the matched or stashed run moves.
    Stash,
}

pub fn keep(strategy: Reorder, old: &[Option<usize>], old_len: usize) -> Vec<bool> {
    match strategy {
        Reorder::Lis => keep_lis(old, old_len),
        Reorder::Forward => keep_forward(old),
        Reorder::Stash => keep_stash(old, old_len),
    }
}

fn keep_forward(old: &[Option<usize>]) -> Vec<bool> {
    let mut last_placed = 0;
    old.iter()
        .map(|o| match *o {
            Some(o) if o >= last_placed => {
                last_placed = o;
                true
            }
            _ => false,
        })
        .collect()
}

/// Vue's `getSequence` (indices of a longest increasing subsequence of the
/// non-zero entries, with its exact tie-breaking).
fn get_sequence(arr: &[usize]) -> Vec<usize> {
    let mut p = arr.to_vec();
    let mut result: Vec<usize> = vec![0];
    for i in 0..arr.len() {
        let arr_i = arr[i];
        if arr_i != 0 {
            let j = *result.last().unwrap();
            if arr[j] < arr_i {
                p[i] = j;
                result.push(i);
                continue;
            }
            let (mut u, mut v) = (0, result.len() - 1);
            while u < v {
                let c = (u + v) >> 1;
                if arr[result[c]] < arr_i {
                    u = c + 1;
                } else {
                    v = c;
                }
            }
            if arr_i < arr[result[u]] {
                if u > 0 {
                    p[i] = result[u - 1];
                }
                result[u] = i;
            }
        }
    }
    let mut u = result.len();
    let mut v = result[u - 1];
    while u > 0 {
        u -= 1;
        result[u] = v;
        v = p[v];
    }
    result
}

fn keep_lis(old: &[Option<usize>], old_len: usize) -> Vec<bool> {
    let new_len = old.len();
    let mut keep: Vec<bool> = old.iter().map(|o| o.is_some()).collect();
    let mut i = 0usize;
    // Sync from the start, then from the end.
    while i < old_len && i < new_len && old[i] == Some(i) {
        i += 1;
    }
    let (mut e1, mut e2) = (old_len as isize - 1, new_len as isize - 1);
    while i as isize <= e1 && i as isize <= e2 && old[e2 as usize] == Some(e1 as usize) {
        e1 -= 1;
        e2 -= 1;
    }
    if i as isize > e1 || i as isize > e2 {
        return keep; // only mounts or unmounts remain
    }
    let (s1, s2) = (i, i);
    let to_be_patched = (e2 - s2 as isize + 1) as usize;
    // New position of each old block in the middle.
    let mut new_index_of = vec![None; old_len];
    for (j, o) in old.iter().enumerate().take(e2 as usize + 1).skip(s2) {
        if let Some(o) = o {
            new_index_of[*o] = Some(j);
        }
    }
    let mut map = vec![0usize; to_be_patched];
    let mut patched = 0;
    let mut moved = false;
    let mut max_new = 0;
    for (o, new_index) in new_index_of
        .iter()
        .enumerate()
        .take(e1 as usize + 1)
        .skip(s1)
    {
        if patched >= to_be_patched {
            continue;
        }
        if let Some(n) = *new_index {
            map[n - s2] = o + 1;
            if n >= max_new {
                max_new = n;
            } else {
                moved = true;
            }
            patched += 1;
        }
    }
    if !moved {
        return keep;
    }
    let seq = get_sequence(&map);
    let mut j = seq.len() as isize - 1;
    for k in (0..to_be_patched).rev() {
        if map[k] == 0 {
            continue;
        }
        if j < 0 || k != seq[j as usize] {
            keep[s2 + k] = false;
        } else {
            j -= 1;
        }
    }
    keep
}

/// Svelte 5's `reconcile`, simulated on a linked list of item effects. New
/// items start offscreen at the end of the list (in creation order); removed
/// items stay in the list until the end. Returns which reused blocks were not
/// passed to `move`.
fn keep_stash(old: &[Option<usize>], old_len: usize) -> Vec<bool> {
    // Effects: old blocks 0..old_len, then new blocks in array order.
    let new_blocks: Vec<usize> = (0..old.len()).filter(|&j| old[j].is_none()).collect();
    let n = old_len + new_blocks.len();
    let effect_at: Vec<usize> = old
        .iter()
        .enumerate()
        .map(|(j, o)| match o {
            Some(o) => *o,
            None => old_len + new_blocks.iter().position(|&b| b == j).unwrap(),
        })
        .collect();
    let mut next: Vec<Option<usize>> = (0..n).map(|e| (e + 1 < n).then_some(e + 1)).collect();
    let mut prev_of: Vec<Option<usize>> = (0..n).map(|e| e.checked_sub(1)).collect();
    let mut first = (n > 0).then_some(0);
    let mut last = n.checked_sub(1);
    let mut offscreen: Vec<bool> = (0..n).map(|e| e >= old_len).collect();
    let mut moved = vec![false; n];

    let link = |prev: Option<usize>,
                nxt: Option<usize>,
                next: &mut Vec<Option<usize>>,
                prev_of: &mut Vec<Option<usize>>,
                first: &mut Option<usize>,
                last: &mut Option<usize>| {
        match prev {
            None => *first = nxt,
            Some(p) => next[p] = nxt,
        }
        match nxt {
            None => *last = prev,
            Some(x) => prev_of[x] = prev,
        }
    };

    let mut current = first;
    let mut prev: Option<usize> = None;
    let mut seen: Option<std::collections::HashSet<usize>> = None;
    let mut matched: Vec<usize> = vec![];
    let mut stashed: Vec<usize> = vec![];
    let mut i = 0usize;
    while i < old.len() {
        let effect = effect_at[i];
        if offscreen[effect] {
            offscreen[effect] = false;
            if Some(effect) == current {
                moved[effect] = true;
            } else {
                let nxt = match prev {
                    Some(p) => next[p],
                    None => current,
                };
                if Some(effect) == last {
                    last = prev_of[effect];
                }
                if let Some(p) = prev_of[effect] {
                    next[p] = next[effect];
                }
                if let Some(x) = next[effect] {
                    prev_of[x] = prev_of[effect];
                }
                link(
                    prev,
                    Some(effect),
                    &mut next,
                    &mut prev_of,
                    &mut first,
                    &mut last,
                );
                link(
                    Some(effect),
                    nxt,
                    &mut next,
                    &mut prev_of,
                    &mut first,
                    &mut last,
                );
                moved[effect] = true;
                prev = Some(effect);
                matched.clear();
                stashed.clear();
                current = next[effect];
                i += 1;
                continue;
            }
        }
        if Some(effect) != current {
            if seen.as_ref().is_some_and(|s| s.contains(&effect)) {
                if matched.len() < stashed.len() {
                    // Move the later (matched) items to the front.
                    let start = stashed[0];
                    prev = prev_of[start];
                    let a = matched[0];
                    let b = *matched.last().unwrap();
                    for &m in &matched {
                        moved[m] = true;
                    }
                    for s in &stashed {
                        seen.as_mut().unwrap().remove(s);
                    }
                    let (ap, bn) = (prev_of[a], next[b]);
                    link(ap, bn, &mut next, &mut prev_of, &mut first, &mut last);
                    link(
                        prev,
                        Some(a),
                        &mut next,
                        &mut prev_of,
                        &mut first,
                        &mut last,
                    );
                    link(
                        Some(b),
                        Some(start),
                        &mut next,
                        &mut prev_of,
                        &mut first,
                        &mut last,
                    );
                    current = Some(start);
                    prev = Some(b);
                    matched.clear();
                    stashed.clear();
                    // Svelte decrements i and continues: the same array index again.
                    continue;
                } else {
                    // Move the earlier item to the back.
                    seen.as_mut().unwrap().remove(&effect);
                    moved[effect] = true;
                    let (ep, en) = (prev_of[effect], next[effect]);
                    link(ep, en, &mut next, &mut prev_of, &mut first, &mut last);
                    let after = match prev {
                        None => first,
                        Some(p) => next[p],
                    };
                    link(
                        Some(effect),
                        after,
                        &mut next,
                        &mut prev_of,
                        &mut first,
                        &mut last,
                    );
                    link(
                        prev,
                        Some(effect),
                        &mut next,
                        &mut prev_of,
                        &mut first,
                        &mut last,
                    );
                    prev = Some(effect);
                    i += 1;
                    continue;
                }
            }
            matched.clear();
            stashed.clear();
            while let Some(c) = current {
                if c == effect {
                    break;
                }
                seen.get_or_insert_with(Default::default).insert(c);
                stashed.push(c);
                current = next[c];
            }
            if current.is_none() {
                i += 1;
                continue;
            }
        }
        if !offscreen[effect] {
            matched.push(effect);
        }
        prev = Some(effect);
        current = next[effect];
        i += 1;
    }
    old.iter().map(|o| o.is_some_and(|o| !moved[o])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moved(strategy: Reorder, old: &[usize], new: &[usize]) -> Vec<usize> {
        let olds: Vec<Option<usize>> = new
            .iter()
            .map(|k| old.iter().position(|o| o == k))
            .collect();
        keep(strategy, &olds, old.len())
            .iter()
            .zip(new)
            .filter(|(k, n)| !**k && old.contains(n))
            .map(|(_, n)| *n)
            .collect()
    }

    #[test]
    fn frameworks_move_different_blocks() {
        // Rows 2,1,3 → 2,3,1 (the M3 components case): Vue moves 3; React and Svelte move 1.
        assert_eq!(moved(Reorder::Lis, &[2, 1, 3], &[2, 3, 1]), vec![3]);
        assert_eq!(moved(Reorder::Forward, &[2, 1, 3], &[2, 3, 1]), vec![1]);
        assert_eq!(moved(Reorder::Stash, &[2, 1, 3], &[2, 3, 1]), vec![1]);
    }

    #[test]
    fn unchanged_and_appended_lists_do_not_move() {
        for s in [Reorder::Lis, Reorder::Forward, Reorder::Stash] {
            assert!(moved(s, &[1, 2, 3], &[1, 2, 3]).is_empty());
            assert!(moved(s, &[1, 2, 3], &[1, 2, 3, 4]).is_empty());
            assert!(moved(s, &[1, 2, 3], &[0, 1, 2, 3]).is_empty());
            assert!(moved(s, &[1, 2, 3], &[1, 3]).is_empty());
        }
    }

    #[test]
    fn reversal() {
        assert_eq!(
            moved(Reorder::Forward, &[1, 2, 3, 4], &[4, 3, 2, 1]),
            vec![3, 2, 1]
        );
        assert_eq!(moved(Reorder::Lis, &[1, 2, 3, 4], &[4, 3, 2, 1]).len(), 3);
    }
}
