// Browser bundle of three.js for the 3D world (client/js/three/*). Built to client/vendor/three.js by `npm run build`
// in this folder. The game code has no build step, so three is exposed as one global: window.THREE (the core plus the
// few post-processing passes the world uses).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

window.THREE = Object.assign({}, THREE, { EffectComposer, RenderPass, ShaderPass, OutputPass });
