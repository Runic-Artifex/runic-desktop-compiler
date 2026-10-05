// The shadcn-svelte site's svelte.config.js (conformance/corpus/north-star.json)
// with this fixture's adapter: adapter-static (prerendered pages) instead of
// adapter-cloudflare, and a single bundle. `componentPreviews()` below is the
// site's preprocessor verbatim. The compiler reads this file as literals;
// only `runic generate` imports it, for its preprocessors (runic.json,
// docs/design/M6-SVELTEKIT.md, phase 2).
import adapter from "@sveltejs/adapter-static";
import MagicString from "magic-string";
import { mdsx } from "mdsx";
import { mdsxConfig } from "./mdsx.config.js";

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [mdsx(mdsxConfig), componentPreviews()],
	extensions: [".svelte", ".md"],

	kit: {
		adapter: adapter(),
		output: { bundleStrategy: "single" },
		alias: {
			"$content/*": ".velite/*",
		},
	},
};

export default config;

/**
 * Detects the `name` of the previewing component, imports it directly and
 * passes it to the `ComponentPreview` as a prop.
 * @returns {import("svelte/compiler").PreprocessorGroup}
 */
function componentPreviews() {
	const TARGET = "<ComponentPreview";
	const camelize = (/** @type {string} */ s) => s.replace(/-./g, (w) => w[1].toUpperCase());

	return {
		name: "inject-component-preview",
		markup: ({ content, filename }) => {
			if (!filename?.endsWith(".md") || !content.includes(TARGET)) return;

			const ms = new MagicString(content);
			const results = content.matchAll(/<ComponentPreview name=["|']([^\s]*)["|']/g);
			const components = new Set();
			for (const exec of results) {
				const [, name] = exec;
				const insertIndex = exec.index + TARGET.length;
				const identifier = camelize(name);
				if (name.includes("sidebar")) continue;
				const prop = ` component={${identifier}}`;
				ms.appendRight(insertIndex, prop);

				components.add(name);
			}

			const importIndex = content.search("import ComponentPreview");
			for (const name of components) {
				const identifier = camelize(name);
				let importStatement;
				if (name.startsWith("chart") && !name.includes("demo")) {
					importStatement = `import ${identifier} from "$lib/registry/blocks/${name}.svelte";`;
				} else if (name.includes("sidebar") || name.includes("Sidebar")) {
					continue;
				} else if (/^calendar-\d+$/.test(name)) {
					importStatement = `import ${identifier} from "$lib/registry/blocks/${name}.svelte";`;
				} else {
					importStatement = `import ${identifier} from "$lib/registry/examples/${name}.svelte";`;
				}

				ms.appendLeft(importIndex, importStatement);
			}

			return { code: ms.toString(), map: ms.generateMap() };
		},
	};
}
