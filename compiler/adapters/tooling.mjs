import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vuePlugin from '@vitejs/plugin-vue';
import { Diagnostic } from '../collect.mjs';

export const supportedVersions = {
  react: ['19.3.0'],
  vue: ['3.5.43', '3.5.24'],
  svelte: ['5.57.1', '5.49.2'],
};
async function resolvedPackage(entry, name) {
  for (let folder = path.dirname(entry); ; folder = path.dirname(folder)) {
    try {
      const info = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
      if (info.name === name) return info;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (path.dirname(folder) === folder)
      throw new Diagnostic('E_FRONTEND_VERSION', 'Cannot locate package metadata for ' + name);
  }
}
function parseSvelte(compiler, root, code, id) {
  try {
    return compiler.parse(code, { filename: id, modern: true });
  } catch (e) {
    throw new Diagnostic('E_PARSE', e.message, {
      file: path.relative(root, id),
      line: e.start?.line ?? 1,
      column: (e.start?.column ?? 0) + 1,
    });
  }
}
function svelteScripts(compiler, root, code, id) {
  if (!id.endsWith('.svelte')) return [{ code, offset: 0 }];
  return Object.values(parseSvelte(compiler, root, code, id))
    .filter(n => n?.type === 'Script')
    .map(n => ({ code: code.slice(n.content.start, n.content.end), offset: n.content.start }));
}
/**
 * The Svelte compiler's `runes` option: the application's components are
 * compiled in runes mode (the mode the Svelte adapter lowers), library
 * components (files under `node_modules`) in the mode their authors wrote
 * them in, which Svelte infers per file (`undefined`), as vite-plugin-svelte
 * compiles them in the site's build, whose config sets no mode. This is
 * SvelteKit's project template rule (`sv create`). A legacy-mode library
 * component is compiled for the collector's bundle; the Svelte adapter
 * lowers one only where runes mode means the same for it, and rejects
 * legacy features (`$$props`, `export let`) it reaches outside a mapping
 * pack (frontend/adapters/svelte.ts).
 */
export const svelteRunes = ({ filename }) =>
  filename?.split(/[/\\]/).includes('node_modules') ? undefined : true;

/** The checked version of Tailwind CSS (runic.json `"tailwind": true`). */
export const tailwindVersion = '4.3.3';

/**
 * The framework tooling for the app, with Tailwind CSS's Vite plugin first
 * when runic.json opts in (`"tailwind": true`); the app's own Vite config is
 * never run.
 */
export async function frontendTooling(root, config) {
  const tooling = withAliases(root, config, await frameworkTooling(root, config));
  if (config.tailwind === undefined || config.tailwind === false) return tooling;
  if (config.tailwind !== true)
    throw new Diagnostic('E_CONFIG', 'runic.json tailwind must be true or false', {
      file: 'runic.json',
      line: 1,
      column: 1,
    });
  const require = createRequire(path.join(root, 'runic.json'));
  let entry;
  try {
    entry = require.resolve('@tailwindcss/vite');
  } catch {
    throw new Diagnostic(
      'E_FRONTEND_VERSION',
      'runic.json enables Tailwind CSS, but @tailwindcss/vite is not installed',
    );
  }
  const pluginVersion = (await resolvedPackage(entry, '@tailwindcss/vite')).version;
  const coreVersion = (await resolvedPackage(require.resolve('tailwindcss'), 'tailwindcss'))
    .version;
  if (pluginVersion !== tailwindVersion || coreVersion !== tailwindVersion)
    throw new Diagnostic(
      'E_FRONTEND_VERSION',
      `Unsupported Tailwind CSS version ${coreVersion} (Vite plugin ${pluginVersion}); checked version: ${tailwindVersion}`,
    );
  const tailwind = (await import(entry)).default;
  return {
    ...tooling,
    plugins: [tailwind(), ...tooling.plugins],
    packages: { ...tooling.packages, tailwindcss: coreVersion, '@tailwindcss/vite': pluginVersion },
    tailwind: true,
  };
}

/**
 * Import aliases (runic.json `"alias": { "$lib": "src/lib" }`), resolved as
 * Vite's `resolve.alias` resolves them: a specifier equal to a key, or
 * starting with the key and `/`, continues in the directory the key names.
 * SvelteKit configures `$lib` this way (`kit.alias`); since the app's own
 * Vite and SvelteKit configs are never run, runic.json states the aliases.
 * Targets are directories inside the application.
 */
function withAliases(root, config, tooling) {
  if (config.alias === undefined) return tooling;
  const at = { file: 'runic.json', line: 1, column: 1 };
  if (typeof config.alias !== 'object' || config.alias === null || Array.isArray(config.alias))
    throw new Diagnostic('E_CONFIG', 'runic.json alias must map specifiers to directories', at);
  const entries = [];
  for (const [find, target] of Object.entries(config.alias)) {
    if (!/^[$@#~\w][\w$@#~.-]*$/.test(find) || find.includes('/'))
      throw new Diagnostic('E_CONFIG', `runic.json alias ${find} must be one path segment`, at);
    const dir = typeof target === 'string' ? path.resolve(root, target) : undefined;
    if (!dir || !(dir === root || dir.startsWith(root + path.sep)))
      throw new Diagnostic(
        'E_CONFIG',
        `runic.json alias ${find} must name a directory inside the application`,
        at,
      );
    entries.push({ find, replacement: dir });
  }
  const plugin = {
    name: 'runic-alias',
    config: () => ({ resolve: { alias: entries } }),
  };
  return { ...tooling, plugins: [plugin, ...tooling.plugins], aliases: entries };
}

async function frameworkTooling(root, config) {
  const name = config.framework ?? 'react',
    require = createRequire(path.join(root, 'runic.json'));
  if (!Object.hasOwn(supportedVersions, name))
    throw new Diagnostic('E_FRONTEND', 'No frontend adapter for ' + name);
  const version = JSON.parse(
    await readFile(require.resolve(name + '/package.json'), 'utf8'),
  ).version;
  if (!supportedVersions[name].includes(version))
    throw new Diagnostic(
      'E_FRONTEND_VERSION',
      `Unsupported ${name} version ${version}; checked versions: ${supportedVersions[name].join(', ')}`,
    );
  if (name === 'react') {
    const domVersion = JSON.parse(
      await readFile(require.resolve('react-dom/package.json'), 'utf8'),
    ).version;
    if (domVersion !== version)
      throw new Diagnostic('E_FRONTEND_VERSION', 'React and React DOM versions must match');
    return {
      name,
      version,
      plugins: [],
      packages: { react: version, 'react-dom': domVersion },
      packageRoot: path.dirname(require.resolve('react/package.json')),
    };
  }
  if (name === 'svelte') {
    const compiler = require('svelte/compiler');
    if (compiler.VERSION !== version)
      throw new Diagnostic('E_FRONTEND_VERSION', 'Svelte runtime and compiler versions must match');
    const { svelte } = await import(require.resolve('@sveltejs/vite-plugin-svelte'));
    const pluginVersion = (
      await resolvedPackage(
        require.resolve('@sveltejs/vite-plugin-svelte'),
        '@sveltejs/vite-plugin-svelte',
      )
    ).version;
    if (pluginVersion !== '7.3.1')
      throw new Diagnostic('E_FRONTEND_VERSION', 'Checked Svelte Vite plugin is 7.3.1');
    return {
      name,
      version,
      compiler,
      // Production output: generated apps implement production semantics,
      // and development builds add instrumentation that changes timing
      // (every `await` gains extra microtask hops through track_reactivity_loss).
      plugins: [svelte({ configFile: false, compilerOptions: { runes: svelteRunes, dev: false } })],
      packages: { svelte: version, '@sveltejs/vite-plugin-svelte': pluginVersion },
      extensions: ['.svelte'],
      scripts: (code, id) => svelteScripts(compiler, root, code, id),
      authoredStyles: (code, id) => {
        if (!id.endsWith('.svelte')) return [];
        const style = parseSvelte(compiler, root, code, id).css;
        return style ? [{ code: style.content.styles, offset: style.content.start }] : [];
      },
      // vite-plugin-svelte's virtual module of a component's `<style>`: the component file.
      componentStyle: id =>
        /\.svelte\?svelte&type=style&lang\.css$/.test(id) ? id.split('?')[0] : undefined,
    };
  }
  const compiler = require('@vue/compiler-sfc');
  if (compiler.version !== version)
    throw new Diagnostic('E_FRONTEND_VERSION', 'Vue runtime and SFC compiler versions must match');
  const descriptor = (code, id) => {
    const parsed = compiler.parse(code, { filename: id });
    if (parsed.errors.length) throw new Diagnostic('E_PARSE', String(parsed.errors[0]));
    return parsed.descriptor;
  };
  return {
    name,
    version,
    compiler,
    plugins: [vuePlugin({ compiler })],
    packages: { vue: version, '@vue/compiler-sfc': compiler.version },
    packageRoot: path.dirname(require.resolve('vue/package.json')),
    extensions: ['.vue'],
    scripts: (code, id) => {
      if (!id.endsWith('.vue')) return [{ code, offset: 0 }];
      const parsed = descriptor(code, id);
      return [parsed.script, parsed.scriptSetup]
        .filter(Boolean)
        .map(s => ({ code: s.content, offset: s.loc.start.offset }));
    },
    authoredStyles: (code, id) => {
      if (id.endsWith('.vue'))
        return descriptor(code, id).styles.map(s => ({
          code: s.content,
          offset: s.loc.start.offset,
        }));
      const [owner, query] = id.split('?');
      const params = new URLSearchParams(query);
      // plugin-vue loads an external CSS style request as its original file
      // text; this pre-transform hook runs before its scoped rewrite.
      if (
        path.extname(owner) === '.css' &&
        params.has('vue') &&
        params.get('type') === 'style' &&
        params.has('src')
      )
        return [{ code, owner, offset: 0 }];
      return [];
    },
  };
}
