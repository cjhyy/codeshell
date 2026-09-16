/* global module, require */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder's CommonJS build hook. */
module.exports = require("./managed-node-signing.cjs").createSigningHooks().macSign;
