import { Breadcrumbs, PageHeader } from "@not-unreachable/design-system";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AccountShell } from "../layout/index.ts";
import { RequireAccount } from "../session/index.ts";
import { AuditLogPage } from "./audit-log.tsx";
import { DashboardPage } from "./dashboard.tsx";
import { AdminFilesPage } from "./files.tsx";
import { ResourcesPage } from "./resources.tsx";
import { AdminSettingsPage } from "./settings.tsx";
import { ShareLinksPage } from "./share-links.tsx";
import { UsersPage } from "./users.tsx";

/** The pages under /admin, by their first segment: the Sidebar item and the breadcrumb. */
const pages = new Map([
  ["audit-log", "Audit log"],
  ["dashboard", "Dashboard"],
  ["files", "Files"],
  ["resources", "Resources"],
  ["settings", "Settings"],
  ["share-links", "Share links"],
  ["users", "Users"],
]);

function AdminNotFound() {
  return <PageHeader title="Page not found" description="There is nothing at this address." />;
}

/** The root of the admin interface: its own chunk, so a user's browser never downloads it. */
export function Component() {
  const { pathname } = useLocation();
  const segment = pathname.split("/")[2] ?? "";
  const label = pages.get(segment);
  return (
    <RequireAccount requiredRole="admin">
      <AccountShell
        activeId={label === undefined ? undefined : segment}
        breadcrumbs={label === undefined ? undefined : <Breadcrumbs items={[{ label }]} />}
      >
        <Routes>
          <Route index element={<Navigate replace to="/admin/dashboard" />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="audit-log" element={<AuditLogPage />} />
          <Route path="files" element={<AdminFilesPage />} />
          <Route path="files/:resourceId" element={<AdminFilesPage />} />
          <Route path="resources" element={<ResourcesPage />} />
          <Route path="settings/*" element={<AdminSettingsPage />} />
          <Route path="share-links" element={<ShareLinksPage />} />
          <Route path="users/*" element={<UsersPage />} />
          <Route path="*" element={<AdminNotFound />} />
        </Routes>
      </AccountShell>
    </RequireAccount>
  );
}
