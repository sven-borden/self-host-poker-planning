import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog.tsx";
import { Input } from "./input.tsx";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./sheet.tsx";

// The design brief asks for 44 px touch targets (size-11, h-11), whatever the icon size.

afterEach(() => {
  cleanup();
});

describe("touch targets", () => {
  it("gives the dialog's close button a 44 px hit area", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("button", { name: "Close" }).className).toContain("size-11");
  });

  it("gives the sheet's close button a 44 px hit area", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Title</SheetTitle>
          <SheetDescription>Body</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole("button", { name: "Close" }).className).toContain("size-11");
  });

  it("makes the input 44 px tall", () => {
    render(<Input aria-label="Name" />);
    expect(screen.getByRole("textbox", { name: "Name" }).className).toContain("h-11");
  });
});
