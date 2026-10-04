import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // A single-page app (as the Translations Editor is built).
    adapter: adapter({ fallback: 'index.html' }),
    router: { type: 'hash' },
    output: { bundleStrategy: 'single' },
  },
};

export default config;
