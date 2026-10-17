import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/cascadia-code/wght.css";
import "@fontsource-variable/noto-sans-tc/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/fira-code/wght.css";
import "@fontsource-variable/source-code-pro/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/roboto-mono/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/lxgw-wenkai-mono-tc/400.css";
import App from "./App";
import { createBrowserApi } from "./api/browser-api";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/instrument-sans/wght.css";
import "./styles.css";
import "./skin-sunmoon.css";
import { watchGlassShader } from "./components/glass-shader";
import { watchSunMoonShader } from "./components/sunmoon-shader";

if (!window.aiTerminal) window.aiTerminal = createBrowserApi();

if (import.meta.env.DEV && !window.aiTerminal) {
  const { installMockApi } = await import("./dev/mock-api");
  installMockApi();
}

watchGlassShader();
watchSunMoonShader();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
