import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/outfit";
import "./styles.css";
import { App } from "./App";
import { applyTheme, cachedTheme } from "./theme";

// Paint in team colours on the very first frame. The network copy lands a
// moment later in App and overwrites this if the admin has changed it.
applyTheme(cachedTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
