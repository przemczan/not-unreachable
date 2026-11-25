// First: it configures zod before any schema is built.
// oxlint-disable-next-line import/no-unassigned-import -- imported for its effect.
import "./zod-config.ts";
import { applyInitialTheme } from "@not-unreachable/design-system";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, createQueryClient } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import "./main.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("The page has no #root element.");
}

applyInitialTheme();
createRoot(container).render(
  <StrictMode>
    <App router={createAppRouter()} queryClient={createQueryClient()} />
  </StrictMode>,
);
