// Bundles the extension host code into dist/extension.js and character webview code into media/character.js.
const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');

const hostOpts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
};

const characterOpts = {
  entryPoints: ['src/panel/character/characterApp.ts'],
  bundle: true,
  outfile: 'media/character.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  minify: true,
  treeShaking: true,
};

(async () => {
  if (watch) {
    const hostCtx = await esbuild.context(hostOpts);
    const charCtx = await esbuild.context(characterOpts);
    await Promise.all([hostCtx.watch(), charCtx.watch()]);
  } else {
    await Promise.all([esbuild.build(hostOpts), esbuild.build(characterOpts)]);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
