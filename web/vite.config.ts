import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Drop index.html's CSP <meta> under `npm run dev` only.
 *
 * The dev server injects an inline React-refresh preamble and talks to its own
 * websocket, and `script-src 'self'` blocks the preamble - the page renders
 * nothing. The production build (`apply: "serve"` never runs there) still
 * ships the strict tag, which must keep matching PAGE_CSP in the Worker.
 */
const devCsp: Plugin = {
  name: "auxgoat-dev-csp",
  apply: "serve",
  transformIndexHtml(html) {
    return html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*>/, "");
  },
};

export default defineConfig({
  plugins: [react(), devCsp],
  build: {
    // Never inline a font into the stylesheet. Vite turns any asset under 4 kB
    // into a data: URI, and two of the smaller font subsets fall under that -
    // but the page's Content-Security-Policy only allows fonts from this
    // origin (font-src 'self'), so an inlined one is silently blocked and the
    // text falls back to a system face. Everything else keeps the default.
    assetsInlineLimit: (file: string) => (file.endsWith(".woff2") ? false : undefined),
    // One entry, and the output bundle is named `index-<hash>.js` because of
    // it. If a second page is ever added here via rollupOptions.input, the
    // app's entry key MUST be `index`: staleBuild.ts locates the running and
    // the served build by matching `/assets/index-<hash>.js`, with a selector
    // and a regex, NEITHER of which fails loudly. Naming it anything else
    // silently disables the reload that stops a tab held across a deploy from
    // executing index.html as JavaScript. Done by accident 2026-08-07 and
    // caught before it shipped; the landing page it was added for now lives
    // in its own Worker (../apex) and is not built here.
    //
    // The Worker serves this directory via its [assets] binding, so the site
    // is same-origin with the API and the session cookie just works.
    outDir: "../backend/public",
    emptyOutDir: true,
    // Anyone opening this is on a phone in a locker room, often on cellular.
    target: "es2020",
  },
  server: {
    // `npm run dev` here alongside `wrangler dev --local` in backend/.
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
