import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // A single-page app with the path router (Kit's default).
    adapter: adapter({ fallback: 'index.html' }),
    output: { bundleStrategy: 'single' },
  },
};

export default config;
