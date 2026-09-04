/* ============================================================
   sparkBook · src/main.tsx
   Renderer entry. Imports design tokens, base reset, and
   the App shell. Mounts into #root.
   ============================================================ */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

/* Coding typography: JetBrains Mono Variable (woff2-variations, normal+italic)
   installed via @fontsource-variable/jetbrains-mono — bundled by Vite. */
import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";

import "./theme/tokens.css";
import "./theme/base.css";
import "./theme/density.css";

const root = document.getElementById("root")!;
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
