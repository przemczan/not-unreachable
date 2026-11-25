// A screen that breaks every rule of the Enforcement table (docs/design/design-system.md).
// lint/fixtures.test.ts lints it with adherence.oxlintrc.json and expects each rule to fire.
// The main lint and the typecheck leave this folder out.
import { Button } from "@not-unreachable/design-system/src/components/button/Button.tsx";
import { FaBeer } from "react-icons/fa";
import { cn } from "../../src/lib/cn.ts";
import "./file-list.css";

const tones = { fg: "#fff" };

export function BadScreen({ offset, html }: { offset: number; html: string }) {
  lucide.createIcons();
  return (
    <div className={cn("w-[13px] text-gray-500", tones.fg)} style={{ marginTop: 8 }}>
      <style>{"@keyframes spin { to { rotate: 1turn; } }"}</style>
      <span className={`shadow-lg ${tones.fg}`} data-offset={`0 ${offset}px`} />
      <p dangerouslySetInnerHTML={{ __html: html }} />
      <FaBeer />
      <Button />
    </div>
  );
}
