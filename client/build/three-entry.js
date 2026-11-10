// Browser bundle of three.js for the optional 3D view. Built to client/vendor/three.js by `npm run build` in this folder.
// Loaded lazily by js/r3d/boot.js, so players on the 2D view never download it.
import * as THREE from 'three';
globalThis.THREE = THREE;
