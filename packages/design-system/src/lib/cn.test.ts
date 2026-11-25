import { describe, expect, it } from "vitest";
import { cn } from "./cn.ts";

describe("cn", () => {
  it("keeps the later of two type roles", () => {
    expect(cn("type-body", "type-label")).toBe("type-label");
  });

  it("knows the theme's named spacing, radius, shadow and container sizes", () => {
    expect(cn("px-page", "px-4")).toBe("px-4");
    expect(cn("h-control-md", "h-control-lg")).toBe("h-control-lg");
    expect(cn("w-sidebar", "w-sidebar-collapsed")).toBe("w-sidebar-collapsed");
    expect(cn("rounded-control", "rounded-card")).toBe("rounded-card");
    expect(cn("shadow-control", "shadow-floating")).toBe("shadow-floating");
    expect(cn("max-w-content", "max-w-95")).toBe("max-w-95");
  });

  it("keeps the later duration and z-index token", () => {
    expect(cn("duration-fast", "duration-slow")).toBe("duration-slow");
    expect(cn("z-dropdown", "z-modal")).toBe("z-modal");
  });

  it("keeps classes of different groups", () => {
    expect(cn("bg-surface", "text-fg-2", "rounded-control", "shadow-control")).toBe("bg-surface text-fg-2 rounded-control shadow-control");
  });
});
