import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Timeline, type TimelineItem } from "./Timeline.tsx";

const items: TimelineItem[] = [
  {
    id: "evt_2",
    actor: "Ada Lovelace",
    title: "signed in",
    time: "14:02",
    dateTime: "2026-10-20T14:02:00Z",
    icon: "log-in",
    tone: "success",
  },
  {
    id: "evt_1",
    actor: "System",
    title: "revoked a share link",
    time: "09:15",
    description: "Expired after 7 days",
    meta: <span>meta block</span>,
  },
];

describe("Timeline", () => {
  it("lists events in order with actor, title, time and description", () => {
    render(<Timeline items={items} />);
    const events = screen.getAllByRole("listitem");
    expect(events).toHaveLength(2);
    expect(events[0]!.textContent).toContain("Ada Lovelace signed in");
    expect(within(events[0]!).getByText("Ada Lovelace").tagName).toBe("STRONG");
    expect(within(events[1]!).getByText("Expired after 7 days")).toBeTruthy();
    expect(within(events[1]!).getByText("meta block")).toBeTruthy();
  });

  it("makes the time a <time> only with a machine-readable dateTime", () => {
    render(<Timeline items={items} />);
    const first = screen.getByText("14:02");
    expect(first.tagName).toBe("TIME");
    expect(first.getAttribute("datetime")).toBe("2026-10-20T14:02:00Z");
    expect(screen.getByText("09:15").tagName).toBe("SPAN");
  });

  it("tints the node by tone and draws the connector except after the last event", () => {
    const { container } = render(<Timeline items={items} />);
    expect(container.querySelector(".bg-success-subtle svg")).not.toBeNull();
    expect(container.querySelector(".bg-surface-sunken svg")).not.toBeNull();
    expect(container.querySelectorAll(".bg-border")).toHaveLength(1);
  });

  it("renders an action per event", async () => {
    const onDetails = vi.fn<() => void>();
    render(
      <Timeline
        items={[
          {
            title: "signed in",
            action: (
              <button type="button" onClick={onDetails}>
                Details
              </button>
            ),
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(onDetails).toHaveBeenCalledTimes(1);
  });

  it("groups events under day headings, each a named section", () => {
    render(
      <Timeline
        groups={[
          { id: "today", heading: "Today", description: "2 events", items },
          { id: "yesterday", heading: "19 Oct 2026", items: [{ title: "signed out" }] },
        ]}
      />,
    );
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Today", "19 Oct 2026"]);
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getAllByRole("listitem")).toHaveLength(2);
    expect(within(today).getByText("2 events")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "19 Oct 2026" })).getAllByRole("listitem")).toHaveLength(1);
  });
});
