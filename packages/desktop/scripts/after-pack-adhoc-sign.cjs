// Supply each target's locked Node before signing the application. All signing
// and integrity errors fail packaging, including local release builds.
/* global exports, require */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder's CommonJS build hook. */
exports.default = require("./managed-node-signing.cjs").createSigningHooks().afterPack;
