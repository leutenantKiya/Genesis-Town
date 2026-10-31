// Minimal Node globals for libraries in the NEAR Auth provider's dependency tree.
import { Buffer } from 'buffer';
globalThis.Buffer = globalThis.Buffer || Buffer;
globalThis.process = globalThis.process || {
  env: { NODE_ENV: 'production' }, browser: true, version: '', versions: {},
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
};
export { Buffer };
