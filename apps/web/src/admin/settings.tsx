import { PageHeader, Tabs, type TabItem } from "@not-unreachable/design-system";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { renderRouterLink } from "../layout/index.ts";
import { LimitsSettings } from "./limits-settings.tsx";
import { MailSettings } from "./mail-settings.tsx";
import { SecuritySettings } from "./security-settings.tsx";
import { SignInProvidersSettings } from "./sign-in-providers.tsx";
import { UpdatesSettings } from "./updates-settings.tsx";

/** One tab per settings section; later sections (General) add theirs here and a route below. */
const tabs: TabItem[] = [
  { value: "security", label: "Security", href: "/admin/settings/security" },
  { value: "email", label: "Email", href: "/admin/settings/email" },
  { value: "sign-in-providers", label: "Sign-in providers", href: "/admin/settings/sign-in-providers" },
  { value: "limits", label: "Limits", href: "/admin/settings/limits" },
  { value: "updates", label: "Updates", href: "/admin/settings/updates" },
];

export function AdminSettingsPage() {
  const { pathname } = useLocation();
  const current = tabs.find((tab) => tab.href !== undefined && pathname.startsWith(tab.href));
  return (
    <>
      <PageHeader title="Settings" description="Settings that apply to the whole instance.">
        <Tabs
          aria-label="Settings sections"
          tabs={tabs}
          renderLink={renderRouterLink}
          {...(current === undefined ? {} : { value: current.value })}
        />
      </PageHeader>
      <Routes>
        <Route path="security" element={<SecuritySettings />} />
        <Route path="email" element={<MailSettings />} />
        <Route path="sign-in-providers" element={<SignInProvidersSettings />} />
        <Route path="limits" element={<LimitsSettings />} />
        <Route path="updates" element={<UpdatesSettings />} />
        <Route path="*" element={<Navigate replace to="/admin/settings/security" />} />
      </Routes>
    </>
  );
}
