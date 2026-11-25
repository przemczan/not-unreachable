import { QuotaMeter } from "@not-unreachable/design-system";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { api } from "../api/index.ts";
import { FileBrowser, folderHref, homeSource, uploadStoreFor } from "../files/index.ts";
import { AccountShell } from "../layout/index.ts";
import { RequireAccount, useSignedInSession } from "../session/index.ts";

/** Under the home's own key, so every change to the home reloads it too. */
const quotaQueryKey = [...homeSource.queryKey, "quota"];

const hrefOf = (path: string) => folderHref("/files", path);

function HomeFiles() {
  const { account } = useSignedInSession();
  const [search] = useSearchParams();
  const path = search.get("path") ?? "";
  const quota = useQuery({ queryKey: quotaQueryKey, queryFn: ({ signal }) => api("getHomeQuota", { signal }) });
  return (
    <FileBrowser
      source={homeSource}
      path={path}
      hrefOf={hrefOf}
      rootLabel="Files"
      title="Files"
      description="The files in your home folder."
      uploads={uploadStoreFor(account.id)}
      aside={
        quota.data === undefined ? undefined : (
          <QuotaMeter className="mr-2 w-56" usedBytes={quota.data.usedBytes} limitBytes={quota.data.limitBytes} />
        )
      }
    />
  );
}

/** The root of the user interface: the admin is sent to /admin. */
export function Component() {
  return (
    <RequireAccount requiredRole="user">
      <AccountShell activeId="files">
        <HomeFiles />
      </AccountShell>
    </RequireAccount>
  );
}
