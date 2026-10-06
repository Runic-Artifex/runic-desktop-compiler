// @floating-ui/dom 1.7.4's autoUpdate (and observeMove, rectsAreEqual), ported
// to the language the compiler lowers: the @floating-ui/dom pack
// (frontend/packs/floating-ui-dom-1.7.4.ts) compiles this module with the
// program and lowers `autoUpdate` to a call of this one.
// floating-ui: MIT License, Copyright (c) 2021-present Floating UI contributors.
//
// Statement by statement as dist/floating-ui.dom.mjs, with these
// differences of form, none observable:
// - The reference and floating elements are elements (virtual elements are
//   not covered), so `unwrapElement(reference)` is the reference.
// - getOverflowAncestors gives the scrolling ancestor elements. Floating-ui's
//   lists both end with the window and its visualViewport (the body after
//   them where it is an overflow element, among the elements here: listeners
//   of one target keep their order); the same listener added twice to one
//   target is one listener, and elements never receive `resize`, so what
//   listens is: each ancestor element's `scroll`, then the window's and the
//   visual viewport's `scroll` and `resize`.
// - `{ passive: true }` is left out of the scroll listeners: `update` never
//   cancels the event, so a passive listener behaves the same.
// - Destructured defaults are written out (`options.x ?? default`), as the
//   destructuring does for undefined.
// - IntersectionObserver's root is the document (floating-ui's try), with
//   the observer's rootMargin and threshold.
// - `root` (the document element) is read where it is used.
import { getOverflowAncestors, type AutoUpdateOptions } from '@floating-ui/dom';

function rectsAreEqual(a: DOMRect, b: DOMRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// https://samthor.au/2021/observing-dom/
function observeMove(element: HTMLElement, onMove: () => void): () => void {
  let io: IntersectionObserver | null = null;
  let timeoutId: number | undefined;
  function cleanup(): void {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (io !== null) io.disconnect();
    io = null;
  }
  function refresh(skip: boolean, threshold: number): void {
    cleanup();
    const elementRectForRootMargin = element.getBoundingClientRect();
    const left = elementRectForRootMargin.left;
    const top = elementRectForRootMargin.top;
    const width = elementRectForRootMargin.width;
    const height = elementRectForRootMargin.height;
    if (!skip) {
      onMove();
    }
    if (!width || !height) {
      return;
    }
    const insetTop = Math.floor(top);
    const insetRight = Math.floor(document.documentElement.clientWidth - (left + width));
    const insetBottom = Math.floor(document.documentElement.clientHeight - (top + height));
    const insetLeft = Math.floor(left);
    const rootMargin =
      -insetTop + 'px ' + -insetRight + 'px ' + -insetBottom + 'px ' + -insetLeft + 'px';
    const observed = Math.max(0, Math.min(1, threshold)) || 1;
    let isFirstUpdate = true;
    function handleObserve(entries: IntersectionObserverEntry[]): void {
      const ratio = entries[0].intersectionRatio;
      if (ratio !== threshold) {
        if (!isFirstUpdate) {
          refresh(false, 1);
          return;
        }
        if (!ratio) {
          // If the reference is clipped, the ratio is 0. Throttle the refresh
          // to prevent an infinite loop of updates.
          timeoutId = setTimeout(() => {
            refresh(false, 1e-7);
          }, 1000);
        } else {
          refresh(false, ratio);
        }
      }
      if (
        ratio === 1 &&
        !rectsAreEqual(elementRectForRootMargin, element.getBoundingClientRect())
      ) {
        refresh(false, 1);
      }
      isFirstUpdate = false;
    }
    io = new IntersectionObserver(handleObserve, {
      rootMargin,
      threshold: observed,
      root: document,
    });
    io.observe(element);
  }
  refresh(true, 1);
  return cleanup;
}

export function autoUpdate(
  reference: HTMLElement,
  floating: HTMLElement,
  update: () => void,
  options?: AutoUpdateOptions,
): () => void {
  const ancestorScroll = options?.ancestorScroll ?? true;
  const ancestorResize = options?.ancestorResize ?? true;
  const elementResize = options?.elementResize ?? true;
  const layoutShift = options?.layoutShift ?? true;
  const animationFrame = options?.animationFrame ?? false;
  const referenceEl = reference;
  const ancestors: HTMLElement[] =
    ancestorScroll || ancestorResize
      ? [...getOverflowAncestors(referenceEl), ...getOverflowAncestors(floating)]
      : [];
  // The window ends each list (see the header).
  const windowListed = ancestorScroll || ancestorResize;
  ancestors.forEach(ancestor => {
    if (ancestorScroll) ancestor.addEventListener('scroll', update);
  });
  if (windowListed && ancestorScroll) window.addEventListener('scroll', update);
  if (windowListed && ancestorResize) window.addEventListener('resize', update);
  if (windowListed && ancestorScroll) visualViewport.addEventListener('scroll', update);
  if (windowListed && ancestorResize) visualViewport.addEventListener('resize', update);
  const cleanupIo = layoutShift ? observeMove(referenceEl, update) : null;
  let reobserveFrame = -1;
  let resizeObserver: ResizeObserver | null = null;
  if (elementResize) {
    resizeObserver = new ResizeObserver(entries => {
      if (entries.length > 0 && entries[0].target === referenceEl && resizeObserver !== null) {
        // Prevent update loops when using the `size` middleware.
        // https://github.com/floating-ui/floating-ui/issues/1740
        resizeObserver.unobserve(floating);
        cancelAnimationFrame(reobserveFrame);
        reobserveFrame = requestAnimationFrame(() => {
          if (resizeObserver !== null) resizeObserver.observe(floating);
        });
      }
      update();
    });
    if (!animationFrame) {
      resizeObserver.observe(referenceEl);
    }
    resizeObserver.observe(floating);
  }
  let frameId = -1;
  let prevRefRect: DOMRect | null = animationFrame ? reference.getBoundingClientRect() : null;
  function frameLoop(): void {
    const nextRefRect = reference.getBoundingClientRect();
    if (prevRefRect !== null && !rectsAreEqual(prevRefRect, nextRefRect)) {
      update();
    }
    prevRefRect = nextRefRect;
    frameId = requestAnimationFrame(frameLoop);
  }
  if (animationFrame) {
    frameLoop();
  }
  update();
  return () => {
    ancestors.forEach(ancestor => {
      if (ancestorScroll) ancestor.removeEventListener('scroll', update);
    });
    if (windowListed && ancestorScroll) window.removeEventListener('scroll', update);
    if (windowListed && ancestorResize) window.removeEventListener('resize', update);
    if (windowListed && ancestorScroll) visualViewport.removeEventListener('scroll', update);
    if (windowListed && ancestorResize) visualViewport.removeEventListener('resize', update);
    if (cleanupIo !== null) cleanupIo();
    if (resizeObserver !== null) resizeObserver.disconnect();
    resizeObserver = null;
    if (animationFrame) {
      cancelAnimationFrame(frameId);
    }
  };
}
