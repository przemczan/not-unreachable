import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TabPanel, Tabs, type TabItem } from "./Tabs.tsx";

const tabs: (string | TabItem)[] = [
  "General",
  "Security",
  { value: "email", label: "Email", disabled: true },
  { value: "providers", label: "Sign-in providers", count: 2 },
];

function Harness({ onChange }: { readonly onChange?: (value: string) => void }) {
  const [value, setValue] = useState("General");
  return (
    <>
      <Tabs
        id="settings"
        aria-label="Settings sections"
        tabs={tabs}
        value={value}
        onChange={(next) => {
          onChange?.(next);
          setValue(next);
        }}
      />
      <TabPanel tabsId="settings" value={value}>
        Panel {value}
      </TabPanel>
    </>
  );
}

describe("Tabs", () => {
  it("is a named tablist whose selected tab controls its panel", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Settings sections" })).toBeTruthy();
    const selected = screen.getByRole("tab", { selected: true });
    expect(selected.textContent).toBe("General");
    expect(selected.classList).toContain("border-accent");
    const panel = screen.getByRole("tabpanel", { name: "General" });
    expect(selected.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.textContent).toBe("Panel General");
  });

  it("gives ids without spaces", () => {
    render(<Tabs id="x" tabs={["Sign-in providers"]} />);
    expect(screen.getByRole("tab").id).toBe("x-tab-Sign-in-providers");
  });

  it("selects a tab on click", async () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("tab", { name: "Security" }));
    expect(onChange).toHaveBeenCalledWith("Security");
    expect(screen.getByRole("tabpanel").textContent).toBe("Panel Security");
  });

  it("has one Tab stop and moves with the arrow keys, Home and End, skipping disabled tabs", async () => {
    render(<Harness />);
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "General" }));
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Security", selected: true }));
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Sign-in providers/, selected: true }));
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "General", selected: true }));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Sign-in providers/ }));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "General" }));
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Sign-in providers/ }));
  });

  it("shows a count", () => {
    render(<Tabs tabs={tabs} />);
    expect(screen.getByRole("tab", { name: /^Sign-in providers\s?2$/ })).toBeTruthy();
  });

  it("has no aria-controls without an id", () => {
    render(<Tabs tabs={["One"]} value="One" />);
    expect(screen.getByRole("tab").hasAttribute("aria-controls")).toBe(false);
  });

  describe("link tabs", () => {
    const links: TabItem[] = [
      { value: "profile", label: "Profile", href: "/settings/profile" },
      { value: "sessions", label: "Sessions", href: "/settings/sessions" },
    ];

    it("render a navigation of links, the current one marked", () => {
      render(<Tabs aria-label="Account" tabs={links} value="sessions" />);
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(screen.getByRole("navigation", { name: "Account" })).toBeTruthy();
      const current = screen.getByRole("link", { name: "Sessions" });
      expect(current.getAttribute("href")).toBe("/settings/sessions");
      expect(current.getAttribute("aria-current")).toBe("page");
      expect(current.classList).toContain("border-accent");
      expect(screen.getByRole("link", { name: "Profile" }).hasAttribute("aria-current")).toBe(false);
    });

    it("render through the router's link", () => {
      render(
        <Tabs
          tabs={links}
          value="profile"
          renderLink={({ href, children, ...rest }) => (
            <a data-router-to={href} href={href} {...rest}>
              {children}
            </a>
          )}
        />,
      );
      expect(screen.getByRole("link", { name: "Profile" }).getAttribute("data-router-to")).toBe("/settings/profile");
    });
  });
});
