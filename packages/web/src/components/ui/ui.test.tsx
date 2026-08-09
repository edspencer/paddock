/**
 * Primitive behaviour tests.
 *
 * These cover the things the primitives do that the ad-hoc markup they replace
 * did NOT do — the focus trap, the focus restore, arrow-key menu navigation,
 * and the `aria-describedby` wiring that no field in the app had. Those are the
 * reason to have primitives at all, so they are the things worth pinning.
 *
 * Deliberately not asserted: class strings. A visual direction is expected to
 * change every one of them (docs/DESIGN.md), so a test that spells out
 * `bg-accent-solid` would just be a tax on the next four workers. Colour is
 * covered properly, and by contrast ratio rather than by name, in
 * `src/styles/tokens.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, Checkbox, Chip, Dialog, EmptyState, Field, Input, Menu, MenuItem, Toggle } from ".";

describe("Button", () => {
  it("shows the loading label and disables itself, so a caller cannot desync the two", async () => {
    const onClick = vi.fn();
    render(
      <Button loading loadingLabel="Saving…" onClick={onClick}>
        Save changes
      </Button>,
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveTextContent("Saving…");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    await userEvent.click(btn).catch(() => {});
    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to type=button so a button inside a form does not submit it", () => {
    render(<Button>Cancel</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });
});

describe("Field", () => {
  it("links help text to the control with aria-describedby", () => {
    render(
      <Field label="Max turns" hint="Upper bound on agent turns in a single run.">
        {(p) => <Input {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText("Max turns");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      "Upper bound on agent turns in a single run.",
    );
  });

  it("an error replaces the hint and marks the control invalid", () => {
    render(
      <Field label="Max turns" hint="Some help" error="Must be a whole number 1–1000.">
        {(p) => <Input {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText("Max turns");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Some help")).not.toBeInTheDocument();
    expect(document.getElementById(input.getAttribute("aria-describedby")!)).toHaveTextContent(
      "Must be a whole number 1–1000.",
    );
  });
});

describe("Toggle", () => {
  it("is a real checkbox with an accessible name, however it is painted", async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Docker sandbox" />);
    const box = screen.getByRole("checkbox", { name: "Docker sandbox" });
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Dialog", () => {
  it("moves focus in on open and puts it back on close", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <Dialog open onClose={() => {}} title="Delete chat">
        <Input aria-label="Confirm" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Confirm"));

    rerender(
      <Dialog open={false} onClose={() => {}} title="Delete chat">
        <Input aria-label="Confirm" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps Tab inside the panel", async () => {
    render(
      <Dialog open onClose={() => {}} title="Delete chat" footer={<Button>Confirm</Button>}>
        <Input aria-label="Reason" />
      </Dialog>,
    );
    const panel = screen.getByRole("dialog");
    const confirm = within(panel).getByRole("button", { name: "Confirm" });
    confirm.focus();
    await userEvent.tab();
    // Wrapped back to the first focusable rather than escaping to the document.
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and on a backdrop click, but not on a click inside", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open onClose={onClose} title="Delete chat">
        <p>body</p>
      </Dialog>,
    );
    fireEvent.click(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(container.firstElementChild!);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("names itself for assistive tech", () => {
    render(
      <Dialog open onClose={() => {}} title="Adopt native chats" role="alertdialog">
        <p>body</p>
      </Dialog>,
    );
    const panel = screen.getByRole("alertdialog", { name: "Adopt native chats" });
    expect(panel).toHaveAttribute("aria-modal", "true");
  });
});

describe("Menu", () => {
  it("moves between items with the arrow keys and wraps", () => {
    render(
      <Menu open onClose={() => {}} label="Actions">
        <MenuItem>Edit details</MenuItem>
        <MenuItem danger>Delete project</MenuItem>
      </Menu>,
    );
    const menu = screen.getByRole("menu", { name: "Actions" });
    const [edit, del] = within(menu).getAllByRole("menuitem");

    edit.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(del);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(edit);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(del);
  });

  it("closes on an outside mousedown and on Escape, not on a click within", () => {
    const onClose = vi.fn();
    render(
      <div>
        <span data-testid="outside">elsewhere</span>
        <Menu open onClose={onClose} label="Actions">
          <MenuItem>Edit details</MenuItem>
        </Menu>
      </div>,
    );
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Edit details" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders nothing when closed", () => {
    render(
      <Menu open={false} onClose={() => {}} label="Actions">
        <MenuItem>Edit details</MenuItem>
      </Menu>,
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders its next step, which is the whole reason it exists", () => {
    render(
      <EmptyState
        variant="panel"
        title="Create your first project"
        body="A project gives your work a home."
        action={<Button variant="primary">New Project</Button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Create your first project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Project" })).toBeInTheDocument();
  });

  it("the inline variant is a quiet one-liner with no heading", () => {
    render(<EmptyState title="Nothing running right now." />);
    expect(screen.getByText("Nothing running right now.")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});

describe("Chip", () => {
  it("takes a domain tone rather than a colour, and can carry a status dot", () => {
    const { container } = render(
      <Chip tone="danger" shape="pill" dot>
        blocked
      </Chip>,
    );
    expect(screen.getByText("blocked")).toBeInTheDocument();
    // The dot is decorative; it must not add anything to the accessible name.
    expect(container.textContent).toBe("blocked");
  });
});

describe("Checkbox", () => {
  it("carries the third state, which JSX alone cannot express (#745)", () => {
    // `indeterminate` is a DOM PROPERTY with no attribute, so a parent checkbox
    // that renders a dash can only be done imperatively. Doing it in the
    // primitive is what stops every caller growing its own ref effect and half
    // of them forgetting the ARIA half.
    const { rerender } = render(<Checkbox aria-label="all" indeterminate checked readOnly />);
    const box = screen.getByLabelText("all") as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box).toHaveAttribute("aria-checked", "mixed");

    rerender(<Checkbox aria-label="all" checked readOnly />);
    expect(box.indeterminate).toBe(false);
    // An ordinary checkbox's state is already implicit — `aria-checked` is set
    // ONLY for the value the implicit mapping cannot produce.
    expect(box).not.toHaveAttribute("aria-checked");
  });
});
