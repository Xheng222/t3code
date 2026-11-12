import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import "../index.css";

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown streaming", () => {
  it("preserves completed code lines and their selection through appends and completion", async () => {
    const message = (tail: string, isStreaming = true) => (
      <ChatMarkdown
        cwd={undefined}
        text={"Code follows.\n~~~ts\nconst stable = 1;\n" + tail}
        isStreaming={isStreaming}
      />
    );
    await using screen = await render(message("con"));
    const code = () => screen.container.querySelector("pre code")!;
    await vi.waitFor(() => expect(code()?.textContent).toBe("const stable = 1;\ncon\n"));
    await vi.waitFor(() => expect(code()?.firstElementChild).not.toBeNull());
    const line = code().firstElementChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(line);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      await screen.rerender(message("const next = 2;"));
      expect(code().firstElementChild).toBe(line);
      expect(selection.toString()).toBe("const stable = 1;");
      await screen.rerender(message("const next = 2;\n~~~", false));
      expect(code().firstElementChild).toBe(line);
      expect(code().textContent).toBe("const stable = 1;\nconst next = 2;\n");
      expect(selection.toString()).toBe("const stable = 1;");
    } finally {
      selection.removeAllRanges();
    }
  });
});
