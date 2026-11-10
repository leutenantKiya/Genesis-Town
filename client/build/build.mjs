import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
// Where the API lives. Empty: same origin (the Node server serves this client). A client hosted apart from the server
// (Vercel) is built with GT_API_BASE=https://<server host>; that server must list this origin in CORS_ORIGINS.
const apiBase = (process.env.GT_API_BASE ?? '').trim().replace(/\/+$/, '');
writeFileSync('../vendor/env.js', `window.GT_API=${JSON.stringify(apiBase)};
`);
await build({
  entryPoints: ['near-entry.js'],
  outfile: '../vendor/near.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'linked',
  inject: ['shims.js'],
  banner: { js: 'globalThis.process=globalThis.process||{env:{NODE_ENV:"production"},browser:true,version:"",versions:{},nextTick:function(f){var a=[].slice.call(arguments,1);queueMicrotask(function(){f.apply(null,a)})}};' },
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  logLevel: 'info',
});
// three.js for the 3D world: its own file, so pages that do not draw the world in 3D never download it
await build({
  entryPoints: ['three-entry.js'],
  outfile: '../vendor/three.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'linked',
  logLevel: 'info',
});
