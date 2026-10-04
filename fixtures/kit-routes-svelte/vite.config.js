// The browser reference build (conformance/harness/browser.mjs); the
// compiler does not run this file.
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [sveltekit()] });
