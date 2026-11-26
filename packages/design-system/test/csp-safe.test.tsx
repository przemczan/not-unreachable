/**
 * Every component and layout the package exports renders under the production CSP
 * (`style-src 'self'`, no inline script, nothing loaded from another origin): no `<style>`,
 * `<script>`, `<link>` or `<iframe>` is put on the page, an inline `style` only sets custom
 * properties (`--*`, read by the compiled classes), and no `src`/`href` leaves the origin.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type * as React from "react";
import { describe, expect, it } from "vitest";
import * as designSystem from "../src/index.ts";
import {
  Alert,
  AppShell,
  AuthLayout,
  Avatar,
  Badge,
  Breadcrumbs,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  CodeInput,
  Combobox,
  CopyField,
  DataTable,
  DescriptionList,
  Dialog,
  Disclosure,
  Drawer,
  DropZone,
  EmptyState,
  ExpiryPicker,
  Field,
  Icon,
  IconButton,
  IconButtonLink,
  Input,
  Logo,
  Menu,
  PageHeader,
  Pagination,
  PasswordInput,
  ProgressBar,
  PublicLayout,
  QrCodePanel,
  QuotaMeter,
  Radio,
  RadioGroup,
  SegmentedControl,
  Select,
  SelectMenu,
  Sidebar,
  Switch,
  TabPanel,
  Tabs,
  Tag,
  Textarea,
  Timeline,
  Toast,
  ToastProvider,
  Tooltip,
  Topbar,
  UploadQueue,
  useToast,
  Wordmark,
  type MenuItem,
  type SidebarSection,
} from "../src/index.ts";

interface Case {
  readonly element: React.ReactElement;
  /** Opens what the component shows only on interaction (a popover). */
  readonly interact?: (user: UserEvent) => Promise<void>;
}

const menuItems: MenuItem[] = [
  { heading: "Row" },
  { label: "Edit", icon: <Icon name="files" size={14} />, shortcut: "E" },
  { divider: true },
  { label: "Delete", danger: true },
];
const sections: SidebarSection[] = [
  {
    title: "Main",
    items: [
      { id: "files", label: "Files", icon: "files", href: "/files", badge: 3 },
      { id: "users", label: "Users", icon: "users" },
    ],
  },
];
const account = { name: "Ada Lovelace", items: [{ label: "Sign out" }] };

function ShowToast() {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => toast.show({ tone: "success", title: "Session signed out", action: <Button size="sm">Undo</Button> })}
    >
      Show toast
    </button>
  );
}

/** One case per exported component: a new export fails the test below until it is added here. */
const cases: Readonly<Record<string, Case>> = {
  Logo: { element: <Logo /> },
  Wordmark: { element: <Wordmark /> },
  Avatar: { element: <Avatar name="Ada Lovelace" src="/avatar.png" /> },
  Badge: { element: <Badge dot>Active</Badge> },
  Breadcrumbs: { element: <Breadcrumbs items={[{ label: "Admin", href: "/admin" }, { label: "Users" }]} /> },
  Button: {
    element: (
      <Button iconLeft={<Icon name="files" />} loading>
        Save
      </Button>
    ),
  },
  ButtonLink: {
    element: (
      <ButtonLink href="/download" download iconLeft={<Icon name="download" />}>
        Download
      </ButtonLink>
    ),
  },
  ExpiryPicker: {
    element: <ExpiryPicker />,
    interact: async (user) => {
      await user.click(screen.getByRole("radio", { name: "Custom" }));
    },
  },
  Card: {
    element: (
      <Card title="Title" subtitle="Subtitle" actions={<Button>Act</Button>} footer="Footer">
        Body
      </Card>
    ),
  },
  Checkbox: { element: <Checkbox label="Remember me" description="On this device" indeterminate /> },
  CodeInput: {
    element: <CodeInput label="Authenticator code" value="12" onChange={() => undefined} hint="From your app" />,
    interact: async (user) => {
      await user.type(screen.getByRole("textbox", { name: "Digit 3 of 6" }), "3");
    },
  },
  CopyField: {
    element: <CopyField label="Command" value="sudo not-unreachable allow-folder /srv/files" />,
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Copy command" }));
    },
  },
  Disclosure: {
    element: <Disclosure title="How to set this up">Steps</Disclosure>,
    interact: async (user) => {
      await user.click(screen.getByText("How to set this up"));
    },
  },
  Field: {
    element: (
      <Field label="Name" hint="Your full name" required>
        <input />
      </Field>
    ),
  },
  Combobox: {
    element: (
      <Combobox
        label="Folder"
        value="ho"
        onChange={() => undefined}
        options={[{ value: "homes" }, { value: "hosts" }]}
        onSelect={() => undefined}
        loading
      />
    ),
    interact: async (user) => {
      await user.click(screen.getByRole("combobox", { name: "Folder" }));
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("listbox")).toBeTruthy();
    },
  },
  Icon: { element: <Icon name="files" /> },
  IconButton: { element: <IconButton icon={<Icon name="files" />} label="Files" /> },
  IconButtonLink: { element: <IconButtonLink href="/download" download icon={<Icon name="download" />} label="Download" /> },
  Input: { element: <Input label="Email" error="Required" iconLeft={<Icon name="files" />} suffix="@" /> },
  Menu: {
    element: <Menu trigger={<button type="button">Actions</button>} items={menuItems} />,
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Actions" }));
      expect(screen.getByRole("menu")).toBeTruthy();
    },
  },
  PageHeader: { element: <PageHeader title="Users" description="Everyone" eyebrow="Admin" meta="3" actions={<Button>New</Button>} /> },
  PasswordInput: {
    element: <PasswordInput label="Password" />,
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Show password" }));
    },
  },
  QrCodePanel: {
    element: <QrCodePanel qrCode="data:image/svg+xml;base64,PHN2Zy8+" alt="QR code" setupKey="JBSWY3DPEHPK3PXP" description="Scan it" />,
  },
  Radio: { element: <Radio label="One" description="The first" /> },
  RadioGroup: {
    element: (
      <RadioGroup
        label="Plan"
        options={[
          { value: "a", label: "A", description: "First" },
          { value: "b", label: "B" },
        ]}
        defaultValue="a"
      />
    ),
  },
  SegmentedControl: {
    element: (
      <SegmentedControl aria-label="View" options={["List", { value: "grid", label: "Grid", icon: <Icon name="files" size={14} /> }]} />
    ),
  },
  Select: {
    element: <Select label="Role" placeholder="Pick one" options={["Admin", { value: "user", label: "User" }]} hint="Their access" />,
  },
  SelectMenu: {
    element: (
      <SelectMenu
        label="Resource"
        hint="Whose files to show"
        value="media"
        onChange={() => undefined}
        options={[
          { value: "media", label: "Media", description: "Local folder · /srv/media" },
          { value: "nas", label: "NAS" },
        ]}
      />
    ),
    interact: async (user) => {
      await user.click(screen.getByRole("combobox", { name: "Resource" }));
      expect(screen.getByRole("listbox")).toBeTruthy();
    },
  },
  Sidebar: { element: <Sidebar header={<Logo />} sections={sections} activeId="files" footer="Footer" /> },
  Switch: { element: <Switch label="Notifications" description="By email" /> },
  Textarea: { element: <Textarea label="Notes" hint="Optional" /> },
  Tooltip: {
    element: (
      <Tooltip content="Export CSV">
        <button type="button">Export</button>
      </Tooltip>
    ),
    interact: async (user) => {
      await user.tab();
      expect(screen.getByRole("tooltip").textContent).toBe("Export CSV");
    },
  },
  Topbar: { element: <Topbar left="Left" center="Center" right="Right" /> },
  Alert: {
    element: (
      <Alert tone="danger" title="Sign-in failed" action={<Button size="sm">Try again</Button>} onClose={() => undefined}>
        The email or password is wrong.
      </Alert>
    ),
  },
  DataTable: {
    element: (
      <DataTable
        caption="Sessions"
        columns={[
          { key: "device", header: "Device" },
          { key: "requests", header: "Requests", align: "right", width: 120, mono: true },
          { key: "status", header: "Status", render: () => <Badge tone="success">Active</Badge> },
        ]}
        rows={[{ id: "ses_1", device: "Firefox", requests: 1284 }]}
      />
    ),
  },
  DescriptionList: {
    element: (
      <>
        <DescriptionList
          labelWidth={96}
          items={[{ label: "Event ID", value: "evt_1", mono: true, copyable: true }, { label: "IP address" }]}
        />
        <DescriptionList layout="stacked" columns={2} items={[{ label: "Actor", value: "System" }]} />
      </>
    ),
  },
  Dialog: {
    element: (
      <Dialog
        title="Sign out this session?"
        description="The device has to sign in again."
        tone="danger"
        width={520}
        onClose={() => undefined}
        actions={<Button variant="danger">Sign out session</Button>}
      >
        Body
      </Dialog>
    ),
  },
  Drawer: {
    element: (
      <Drawer
        title="Session signed out"
        description="14:02 UTC"
        width={560}
        onClose={() => undefined}
        footer={<Button variant="secondary">Copy JSON</Button>}
      >
        Fields
      </Drawer>
    ),
  },
  EmptyState: {
    element: (
      <EmptyState icon="folder-open" title="No files yet" description="Upload files to start." action={<Button>Upload files</Button>} />
    ),
  },
  Pagination: { element: <Pagination summary="Showing 50 events" hasNext /> },
  Tabs: {
    element: (
      <>
        <Tabs id="t" aria-label="Sections" tabs={["General", { value: "security", label: "Security", count: 2 }]} value="General" />
        <Tabs aria-label="Account" value="profile" tabs={[{ value: "profile", label: "Profile", href: "/settings/profile" }]} />
      </>
    ),
  },
  TabPanel: {
    element: (
      <TabPanel tabsId="t" value="General">
        Panel
      </TabPanel>
    ),
  },
  Tag: {
    element: (
      <>
        <Tag selected onClick={() => undefined} count={3}>
          Failed
        </Tag>
        <Tag onRemove={() => undefined} icon={<Icon name="files" size={14} />}>
          Files
        </Tag>
      </>
    ),
  },
  Timeline: {
    element: (
      <Timeline
        groups={[
          {
            heading: "Today",
            description: "1 event",
            items: [
              {
                actor: "Ada",
                title: "signed in",
                time: "14:02",
                dateTime: "2026-10-20T14:02:00Z",
                tone: "success",
                meta: <Badge>Web</Badge>,
                action: <Button size="sm">Details</Button>,
              },
            ],
          },
        ]}
      />
    ),
  },
  Toast: { element: <Toast tone="success" title="Link revoked" description="Nobody can open it now." onClose={() => undefined} /> },
  ToastProvider: {
    element: (
      <ToastProvider>
        <ShowToast />
      </ToastProvider>
    ),
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Show toast" }));
      expect(screen.getByText("Session signed out")).toBeTruthy();
    },
  },
  AppShell: {
    element: (
      <>
        <AppShell
          variant="admin"
          sections={sections}
          activeId="files"
          breadcrumbs={<Breadcrumbs items={[{ label: "Files" }]} />}
          account={account}
        >
          <PageHeader title="Files" />
        </AppShell>
        <AppShell variant="user" sections={sections} account={{ name: "Grace Hopper", items: [{ label: "Profile" }] }} />
      </>
    ),
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Account: Ada Lovelace" }));
      expect(screen.getByRole("menu")).toBeTruthy();
    },
  },
  AuthLayout: {
    element: (
      <AuthLayout title="Sign in" description="Welcome back" footer="Footer">
        Form
      </AuthLayout>
    ),
  },
  PublicLayout: { element: <PublicLayout>Content</PublicLayout> },
  ProgressBar: { element: <ProgressBar label="Upload of report.pdf" value={40} /> },
  QuotaMeter: { element: <QuotaMeter usedBytes={4_200_000_000} limitBytes={10_000_000_000} /> },
  DropZone: {
    element: <DropZone onFiles={() => undefined} description="Into Photos" />,
    interact: async () => {
      fireEvent.dragEnter(window, { dataTransfer: { types: ["Files"], files: [] } });
      expect(await screen.findByRole("region", { name: "Drop files to upload" })).toBeTruthy();
    },
  },
  UploadQueue: {
    element: (
      <UploadQueue
        items={[
          { id: "1", name: "report.pdf", bytesSent: 10, bytesTotal: 40, state: "uploading" },
          { id: "2", name: "photo.jpg", bytesSent: 0, bytesTotal: 40, state: "failed", error: "Not enough space" },
        ]}
        onPause={() => undefined}
        onResume={() => undefined}
        onCancel={() => undefined}
        onClose={() => undefined}
      />
    ),
  },
};

function isComponent(name: string, value: unknown): boolean {
  if (!/^[A-Z]/.test(name)) return false;
  // forwardRef/memo components are objects tagged with $$typeof.
  return typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value);
}

const exportedComponents = Object.entries(designSystem)
  .filter(([name, value]) => isComponent(name, value))
  .map(([name]) => name);

/** A `src`/`href` that would load or lead to another origin. */
const OFF_ORIGIN = /^(?:https?:|\/\/)/i;
const URL_ATTRIBUTES = ["src", "href", "srcset", "action", "formaction"] as const;

function expectCspSafe(headBefore: readonly Element[]): void {
  // test/setup.ts adds a test-only <style> to <head> before any test: only compare with that.
  expect(Array.from(document.head.children)).toEqual(headBefore);
  expect(document.body.querySelectorAll("style, script, link, iframe")).toHaveLength(0);
  const nonCustomStyles = Array.from(document.querySelectorAll("[style]")).flatMap((element) =>
    (element.getAttribute("style") ?? "")
      .split(";")
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration !== "" && !/^--[\w-]+\s*:/.test(declaration))
      .map((declaration) => `${declaration} in ${element.outerHTML}`),
  );
  expect(nonCustomStyles).toEqual([]);
  const offOrigin = Array.from(document.querySelectorAll("[src], [href], [srcset], [action], [formaction]")).flatMap((element) =>
    URL_ATTRIBUTES.map((attribute) => element.getAttribute(attribute)?.trim())
      .filter((value) => value !== undefined && OFF_ORIGIN.test(value))
      .map((value) => `${value} in ${element.outerHTML}`),
  );
  expect(offOrigin).toEqual([]);
}

async function noInteraction(): Promise<void> {
  // Nothing to open.
}

describe("CSP safety of every exported component", () => {
  it("has a case for every exported component, and no case for anything else", () => {
    expect(exportedComponents.toSorted()).toEqual(Object.keys(cases).toSorted());
  });

  it.each(exportedComponents)("%s renders no style/script/link/iframe, only custom-property styles, nothing off-origin", async (name) => {
    const testCase = cases[name];
    if (testCase === undefined) throw new Error(`Add a case for ${name} to test/csp-safe.test.tsx.`);
    const headBefore = Array.from(document.head.children);
    const user = userEvent.setup();
    render(testCase.element);
    expectCspSafe(headBefore);
    await (testCase.interact ?? noInteraction)(user);
    expectCspSafe(headBefore);
  });
});
