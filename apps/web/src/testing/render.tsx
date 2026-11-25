import { render, type RenderResult } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { createMemoryRouter } from "react-router";
import { App, createQueryClient } from "../app.tsx";
import { routes } from "../router.tsx";

export interface RenderedApp {
  readonly router: ReturnType<typeof createMemoryRouter>;
  readonly queryClient: QueryClient;
  readonly view: RenderResult;
}

/** Renders the whole app at a path, with a memory router and a fresh query client. */
export function renderApp(path: string): RenderedApp {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = createQueryClient();
  const view = render(<App router={router} queryClient={queryClient} />);
  return { router, queryClient, view };
}
