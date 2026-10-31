// Browser bundle for the game: near-api-js (session-key signing of NEP-366 delegate actions) and the NEAR Auth
// JavaScript provider (Auth0 login). Built to client/vendor/near.js by `npm run build` in this folder.
import {
  KeyPair, PublicKey, Signature, JsonRpcProvider, actions, teraToGas,
  buildDelegateAction, encodeDelegateAction, encodeSignedDelegate,
} from 'near-api-js';
import { JavascriptProvider } from '@fast-auth-near/javascript-provider';

window.NearLib = {
  KeyPair, PublicKey, Signature, JsonRpcProvider, actions, teraToGas,
  buildDelegateAction, encodeDelegateAction, encodeSignedDelegate, JavascriptProvider,
};
