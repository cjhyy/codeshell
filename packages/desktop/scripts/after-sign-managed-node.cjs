/* global exports, require */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder's CommonJS build hook. */
exports.default = require("./managed-node-signing.cjs").createSigningHooks().afterSign;
