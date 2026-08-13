import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
// Preload the Fraunces weight axis (the hero headline) so it doesn't flash the
// Georgia fallback on first paint. Vite hashes/resolves the URL at build time.
import frauncesWght from "@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2?url";
import App from "./App";
import "./styles.css";

const pre = document.createElement("link");
pre.rel = "preload";
pre.as = "font";
pre.type = "font/woff2";
pre.crossOrigin = "anonymous";
pre.href = frauncesWght;
document.head.appendChild(pre);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
