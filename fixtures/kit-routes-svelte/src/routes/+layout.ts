// The app renders in the browser only (an SPA).
export const ssr = false;

export function load() {
  console.log('load root');
  return { site: 'Runic' };
}
