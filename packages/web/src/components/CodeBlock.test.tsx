import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CodeBlock } from "./CodeBlock";

describe("CodeBlock", () => {
  it("renders the raw code synchronously (no empty flash) inside a pre>code", () => {
    const { container } = render(<CodeBlock code={"def hi():\n    pass"} language="python" />);
    // The literal source is present immediately, before the async highlighter loads.
    expect(screen.getByText(/def hi/)).toBeInTheDocument();
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.className).toContain("font-mono");
    expect(pre?.querySelector("code")).not.toBeNull();
  });

  it("upgrades to highlighted markup with hljs token spans for a known language", async () => {
    const { container } = render(<CodeBlock code={"def hi():\n    return 1"} language="python" />);
    await waitFor(() => {
      const code = container.querySelector("code.hljs");
      expect(code).not.toBeNull();
      // At least one scoped token span from the grammar (e.g. the `def` keyword).
      expect(container.querySelector("code.hljs .hljs-keyword")).not.toBeNull();
    });
    // The registered language label lands on the <code> element.
    expect(container.querySelector("code.language-python")).not.toBeNull();
  });

  it("maps aliases (tsx -> typescript) onto a real grammar", async () => {
    const { container } = render(
      <CodeBlock code={"const x: number = 1;"} language="tsx" />,
    );
    await waitFor(() => {
      expect(container.querySelector("code.hljs")).not.toBeNull();
    });
    // Alias resolves to the typescript grammar for the className too.
    expect(container.querySelector("code.language-typescript")).not.toBeNull();
  });

  it("stays plain (no hljs) when the language is unknown/undefined", async () => {
    const { container } = render(<CodeBlock code={"just some text"} />);
    // Give any async work a chance; it should never add the hljs class.
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("code.hljs")).toBeNull();
    expect(screen.getByText("just some text")).toBeInTheDocument();
  });
});
