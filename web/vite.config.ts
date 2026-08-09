import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    // Two pages, not one. `index.html` is the team app; `landing.html` is
    // auxgoat.com's front door, which the Worker serves at the apex.
    //
    // The landing page HAS to be built rather than hand-placed in
    // backend/public/, because emptyOutDir below deletes that directory on
    // every build — a hand-written file there would vanish during unrelated
    // frontend work, with nothing connecting cause to effect.
    // The app's entry key MUST stay `index`. It names the output bundle, and
    // staleBuild.ts finds the running and the served build by matching
    // `/assets/index-<hash>.js` — a selector and a regex, neither of which
    // fails loudly. Renaming this key to `main` silently disables the reload
    // that stops a tab held across a deploy from executing index.html as
    // JavaScript. Done by accident 2026-08-07; caught before it shipped.
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        landing: resolve(__dirname, "landing.html"),
      },
    },
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
