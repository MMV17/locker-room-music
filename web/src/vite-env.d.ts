/// <reference types="vite/client" />

// Without this, `import logo from "./assets/auxgoat.png"` type-errors: Vite
// resolves asset imports to a URL string at build time, but tsc has no idea
// that is a module unless it is told. Nothing here affects the bundle.
