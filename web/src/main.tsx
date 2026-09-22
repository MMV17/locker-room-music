import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/outfit";
// Archivo carries every piece of chrome: eyebrows, timers, jersey numbers,
// vote captions. Self-hosted like Outfit rather than pulled from Google —
// the campus filter blocks whole domains, and a webfont that fails to load
// on the one network this is used on is not a webfont.
import "@fontsource-variable/archivo";
import "./styles.css";
import { App } from "./App";
import { watchForStaleBuild } from "./staleBuild";
import { captureHandoff } from "./handoff";

// Take the team code out of the URL before anything renders. This runs here,
// not in Join, because Join never mounts for someone who already has a
// session — and the code would then sit in their address bar all session.
captureHandoff();

// A tab left open across a deploy is running a bundle the server no longer
// has, and unknown asset paths come back as index.html with a 200 — so it
// would try to execute HTML as JavaScript. Reload once instead.
watchForStaleBuild();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
