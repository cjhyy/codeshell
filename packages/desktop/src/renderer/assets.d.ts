// Ambient module declarations for static asset imports handled by Vite.
// Without these, `import dog from "./assets/foo.png"` has no type and tsc errors.
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.webp" {
  const src: string;
  export default src;
}
