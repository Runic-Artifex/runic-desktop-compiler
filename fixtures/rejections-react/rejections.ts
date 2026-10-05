// Unhandled promise rejections, which Chromium reports on the console
// ("Uncaught (in promise) Error: message") in a task after the microtask
// checkpoint that left them without a handler; handled ones are not
// reported. Console lines around them show when.

export function rejectNow(): void {
  console.log('before');
  Promise.reject(new Error('rejected'));
  queueMicrotask(() => console.log('microtask'));
  console.log('after');
}

export function handledInMicrotask(): void {
  const p = Promise.reject(new Error('handled'));
  queueMicrotask(() => {
    p.catch(e => console.log('caught ' + e.message));
  });
}

export function chained(): void {
  Promise.resolve(1).then(n => {
    if (n > 0) throw new RangeError('in then');
    return n;
  });
  Promise.all([Promise.resolve(1), Promise.reject<number>(new Error('in all'))]);
  Promise.reject(new Error(''));
  Promise.reject(new TypeError('finally')).finally(() => console.log('finally ran'));
  console.log('chained');
}

export async function failLater(): Promise<void> {
  await Promise.resolve();
  console.log('awaited');
  throw new TypeError('async failure');
}

export function timer(): void {
  setTimeout(() => {
    console.log('timer');
    Promise.reject(new Error('timer'));
  }, 100);
}
