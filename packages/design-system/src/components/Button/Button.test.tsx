import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button, ButtonLink } from "./Button.tsx";

describe("Button", () => {
  it("renders a button named by its label, type button by default", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("type")).toBe("button");
  });

  it("calls onClick", async () => {
    const onClick = vi.fn<() => void>();
    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is primary and md by default", () => {
    render(<Button>Save</Button>);
    const { classList } = screen.getByRole("button");
    expect(classList).toContain("bg-primary");
    expect(classList).toContain("text-primary-fg");
    expect(classList).toContain("h-control-md");
  });

  it("fills accent with accent-fill behind fg-on-accent, never bg-accent", () => {
    render(<Button variant="accent">Sign in</Button>);
    const { classList } = screen.getByRole("button");
    expect(classList).toContain("bg-accent-fill");
    expect(classList).toContain("text-fg-on-accent");
    expect(classList).toContain("enabled:hover:bg-accent-fill-hover");
    expect(classList).not.toContain("bg-accent");
  });

  it("keeps the strong border on secondary", () => {
    render(<Button variant="secondary">Export</Button>);
    expect(screen.getByRole("button").classList).toContain("border-border-strong");
  });

  it.each([
    ["danger", "bg-danger"],
    ["danger-ghost", "text-danger-fg"],
    ["ghost", "bg-transparent"],
  ] as const)("styles the %s variant", (variant, expected) => {
    render(<Button variant={variant}>Go</Button>);
    expect(screen.getByRole("button").classList).toContain(expected);
  });

  it.each([
    ["sm", "h-control-sm"],
    ["lg", "h-control-lg"],
  ] as const)("sizes %s", (size, expected) => {
    render(<Button size={size}>Go</Button>);
    expect(screen.getByRole("button").classList).toContain(expected);
  });

  it("stretches with fullWidth and merges className", () => {
    render(
      <Button fullWidth className="mt-2">
        Go
      </Button>,
    );
    const { classList } = screen.getByRole("button");
    expect(classList).toContain("w-full");
    expect(classList).toContain("mt-2");
  });

  it("renders icons around the label", () => {
    render(
      <Button iconLeft={<span data-testid="left" />} iconRight={<span data-testid="right" />}>
        Go
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button.firstElementChild).toBe(screen.getByTestId("left"));
    expect(button.lastElementChild).toBe(screen.getByTestId("right"));
  });

  it("is disabled and ignores clicks when disabled", async () => {
    const onClick = vi.fn<() => void>();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Save" });
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows a spinner instead of iconLeft, sets aria-busy and disables while loading", () => {
    render(
      <Button loading iconLeft={<span data-testid="left" />}>
        Saving
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Saving" });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("left")).toBeNull();
    expect(button.querySelector("svg.animate-spin")).not.toBeNull();
  });
});

describe("ButtonLink", () => {
  it("is a plain link styled as a button, with its download attribute", () => {
    render(
      <ButtonLink href="/files/report.pdf" download variant="secondary" iconLeft={<span data-testid="icon" />}>
        Download
      </ButtonLink>,
    );
    const link = screen.getByRole("link", { name: "Download" });
    expect(link.getAttribute("href")).toBe("/files/report.pdf");
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.classList).toContain("border-border-strong");
    expect(link.classList).toContain("hover:bg-control-hover");
    expect(link.classList).toContain("no-underline");
    expect(link.firstElementChild).toBe(screen.getByTestId("icon"));
  });

  it("is primary and md by default", () => {
    render(<ButtonLink href="/next">Continue</ButtonLink>);
    const { classList } = screen.getByRole("link");
    expect(classList).toContain("bg-primary");
    expect(classList).toContain("h-control-md");
  });
});
