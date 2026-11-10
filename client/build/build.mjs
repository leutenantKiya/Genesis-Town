import { build } from 'esbuild';
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
// three.js for the optional 3D view: no NEAR shims, loaded only on demand.
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
