import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
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
