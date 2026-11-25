import { Breadcrumbs, PageHeader, Tabs, type TabItem } from "@not-unreachable/design-system";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AccountShell, renderRouterLink } from "../layout/index.ts";
import { RequireAccount, useSignedInSession } from "../session/index.ts";
import { LinkedSignInsSettings } from "./linked-sign-ins.tsx";
import { PasswordSettings } from "./password.tsx";
import { ProfileSettings } from "./profile.tsx";
import { SessionsSettings } from "./sessions.tsx";
import { TwoStepSignInSettings } from "./two-step-sign-in.tsx";

const profileTab: TabItem = { value: "profile", label: "Profile", href: "/settings/profile" };
const passwordTab: TabItem = { value: "password", label: "Password", href: "/settings/password" };
const twoStepSignInTab: TabItem = { value: "two-step-sign-in", label: "Two-step sign-in", href: "/settings/two-step-sign-in" };
const linkedSignInsTab: TabItem = { value: "linked-sign-ins", label: "Linked sign-ins", href: "/settings/linked-sign-ins" };
const sessionsTab: TabItem = { value: "sessions", label: "Sessions", href: "/settings/sessions" };

function AccountSettings() {
  const { account } = useSignedInSession();
  const { pathname } = useLocation();
  // Only the admin has a password, and the second factor that goes with it; a user signs in another way.
  const hasPassword = account.role === "admin";
  const tabs = hasPassword
    ? [profileTab, passwordTab, twoStepSignInTab, linkedSignInsTab, sessionsTab]
    : [profileTab, linkedSignInsTab, sessionsTab];
  const current = tabs.find((tab) => tab.href === pathname);

  return (
    <AccountShell breadcrumbs={<Breadcrumbs items={[{ label: "Account settings" }]} />}>
      <PageHeader title="Account settings" description="Your own profile and sign-ins.">
        <Tabs
          aria-label="Account settings sections"
          tabs={tabs}
          renderLink={renderRouterLink}
          {...(current === undefined ? {} : { value: current.value })}
        />
      </PageHeader>
      <Routes>
        <Route path="profile" element={<ProfileSettings />} />
        {hasPassword && <Route path="password" element={<PasswordSettings />} />}
        {hasPassword && <Route path="two-step-sign-in" element={<TwoStepSignInSettings />} />}
        <Route path="linked-sign-ins" element={<LinkedSignInsSettings />} />
        <Route path="sessions" element={<SessionsSettings />} />
        <Route path="*" element={<Navigate replace to="/settings/profile" />} />
      </Routes>
    </AccountShell>
  );
}

/** The account settings both roles share, in the role's own AppShell: a chunk that imports neither interface. */
export function Component() {
  return (
    <RequireAccount>
      <AccountSettings />
    </RequireAccount>
  );
}
