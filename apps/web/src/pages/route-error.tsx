import { Button, PageHeader, PublicLayout } from "@not-unreachable/design-system";
import { browserNavigation } from "../lib/index.ts";

/** Shown when a route fails to load or render, or the server can't be reached; never echoes the error itself. */
export function RouteError() {
  return (
    <PublicLayout>
      <PageHeader
        title="Something went wrong"
        description="The page could not be loaded. Check your connection, then try again."
        actions={
          <Button variant="accent" onClick={() => browserNavigation.reload()}>
            Try again
          </Button>
        }
      />
    </PublicLayout>
  );
}
