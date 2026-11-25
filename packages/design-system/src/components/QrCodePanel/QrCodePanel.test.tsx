import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { QrCodePanel } from "./QrCodePanel.tsx";

const qrCode = "data:image/svg+xml;base64,PHN2Zy8+";

describe("QrCodePanel", () => {
  it("shows the QR code as an image of the given URL, with its text alternative", () => {
    render(<QrCodePanel qrCode={qrCode} alt="QR code for your authenticator app" setupKey="JBSWY3DPEHPK3PXP" />);
    expect(screen.getByRole("img", { name: "QR code for your authenticator app" }).getAttribute("src")).toBe(qrCode);
  });

  it("shows the setup key in a CopyField that copies it", async () => {
    const user = userEvent.setup();
    render(<QrCodePanel qrCode={qrCode} alt="QR code" setupKey="JBSWY3DPEHPK3PXP" description="Or type the key in" />);

    expect(screen.getByRole("group", { name: "Setup key" }).querySelector("code")?.textContent).toBe("JBSWY3DPEHPK3PXP");
    expect(screen.getByText("Or type the key in")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy setup key" }));
    expect(await navigator.clipboard.readText()).toBe("JBSWY3DPEHPK3PXP");
  });
});
