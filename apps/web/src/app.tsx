import { problemTypes } from "@not-unreachable/contracts";
import { ToastProvider } from "@not-unreachable/design-system";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router/dom";
import type { createBrowserRouter } from "react-router";
import { ApiError } from "./api/index.ts";
import { RecentSignInProvider, sessionQueryKey } from "./session/index.ts";

type DataRouter = ReturnType<typeof createBrowserRouter>;

export function createQueryClient() {
  // The session ended (timeout, signed out elsewhere): forget it, so the pages send the visitor to sign in.
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.type === problemTypes.signInRequired) queryClient.setQueryData(sessionQueryKey, null);
  };
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        // A problem answer won't change on a retry; a network error or a 5xx might.
        retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status < 500),
        refetchOnWindowFocus: false,
      },
    },
  });
  return queryClient;
}

export interface AppProps {
  readonly router: DataRouter;
  readonly queryClient: QueryClient;
}

export function App({ router, queryClient }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RecentSignInProvider>
          <RouterProvider router={router} />
        </RecentSignInProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
