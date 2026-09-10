// Puppeteer's optional BiDi dependency includes a Node fallback for UUIDs.
// The extension always uses Chrome's native Web Crypto implementation.
export const webcrypto = globalThis.crypto;
