import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
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
