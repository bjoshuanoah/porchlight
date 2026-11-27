import React, { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
// PORCH-042: the token layer and the mode store — one token contract, two
// renderings; the display mode is a device-level, browser-local preference.
import { darkTokens, lightTokens, themeFor, tokenStyles } from "./theme.js";
import { MODE_KEY, readStoredMode, resolveMode } from "./mode.js";
import App from "./App.jsx";

// PORCH-042: both modes' custom properties land in one static <style> block
// before the first render — component CSS resolves from the token layer with
// no screen-level mode branch, and a mode switch needs no CSS rewrite.
document.head.appendChild(Object.assign(document.createElement("style"), { textContent: tokenStyles() }));

const stored = window.localStorage;
// Same-tab store writes (a settings surface choosing Light / Dark / System)
// signal the bootstrap with this plain window Event: writeStoredMode(...)
// then window.dispatchEvent(new Event("porchlight:mode-changed")). Cross-tab
// sync rides the browser storage event — no extra machinery.
const MODE_CHANGED_EVENT = "porchlight:mode-changed";

function ThemeRoot({ children }) {
  // PORCH-042: mode is a device-level display setting held in this origin's
  // browser-local storage (never a server write); System follows the device's
  // prefers-color-scheme live, so the resolved mode re-renders in place —
  // the switch is one paint frame, never a reload.
  const [modePref, setModePref] = useState(() => readStoredMode(stored));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const displayMode = resolveMode(modePref, systemDark);
  const muiTheme = themeFor(displayMode);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    const adoptStoredMode = () => setModePref(readStoredMode(stored));
    const onStorage = (event) => {
      if (!event.key || event.key === MODE_KEY) adoptStoredMode();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(MODE_CHANGED_EVENT, adoptStoredMode);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(MODE_CHANGED_EVENT, adoptStoredMode);
    };
  }, []);
  useEffect(() => {
    // Sync the pre-paint state (html[data-theme], the pre-paint background,
    // theme-color meta) with the running app after every resolved change.
    const page = displayMode === "dark" ? darkTokens.page : lightTokens.page;
    document.documentElement.dataset.theme = displayMode;
    document.documentElement.style.backgroundColor = page;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", page);
  }, [displayMode]);
  return <ThemeProvider theme={muiTheme}>{children}</ThemeProvider>;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ThemeRoot>
      <App />
    </ThemeRoot>
  </StrictMode>,
);
