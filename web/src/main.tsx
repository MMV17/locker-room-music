import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/outfit";
import "./styles.css";
import { App } from "./App";
import { applyTheme, cachedTheme } from "./theme";
import { watchForStaleBuild } from "./staleBuild";
import { captureHandoff } from "./handoff";

// Take the team code out of the URL before anything renders. This runs here,
// not in Join, because Join never mounts for someone who already has a
// session — and the code would then sit in their address bar all session.
captureHandoff();

// Paint in team colours on the very first frame. The network copy lands a
// moment later in App and overwrites this if the admin has changed it.
applyTheme(cachedTheme());

// A tab left open across a deploy is running a bundle the server no longer
// has, and unknown asset paths come back as index.html with a 200 — so it
// would try to execute HTML as JavaScript. Reload once instead.
watchForStaleBuild();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
