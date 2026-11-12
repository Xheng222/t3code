import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { attachStreamingReveal } from "./streamingReveal.fork";

it.each([false, true])(
  "preserves graphemes and selection while received text grows (fade=%s)",
  async (fadeIn) => {
    const message = (text: string) => <p>{text}</p>;
    await using screen = await render(message("A👩🏽‍💻éZ"));
    screen.container.style.position = "relative";
    screen.container.style.backgroundColor = "rgb(20 20 20)";
    let notify = () => {};
    const progress = { visible: 0, received: 4, complete: false };
    const controller = attachStreamingReveal(
      screen.container,
      (listener) => {
        notify = listener;
        return () => {
          notify = () => {};
        };
      },
      () => progress,
      fadeIn,
    );
    using _controller = { [Symbol.dispose]: controller.dispose };
    const paragraph = screen.container.querySelector("p")!;
    expect(paragraph.textContent).toBe("");
    progress.visible = 2;
    notify();
    expect(paragraph.textContent).toBe("A👩🏽‍💻");
    progress.received = 5;
    await screen.rerender(message("A👩🏽‍💻éZX"));
    await vi.waitFor(() => expect(paragraph.textContent).toBe("A👩🏽‍💻"));
    const firstText = () =>
      document
        .createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) =>
            node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
        })
        .nextNode()!;
    const range = document.createRange();
    range.setStart(firstText(), 0);
    range.setEnd(firstText(), 1);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      progress.visible = 3;
      notify();
      expect(paragraph.textContent).toBe("A👩🏽‍💻é");
      expect(selection.toString()).toBe("A");
      progress.received = 6;
      progress.visible = 4;
      await screen.rerender(message("A👩🏽‍💻éZXY"));
      await vi.waitFor(() => expect(paragraph.textContent).toBe("A👩🏽‍💻éZ"));
      selection.removeAllRanges();
      progress.visible = 6;
      notify();
      const tail = document
        .createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) =>
            node.textContent?.includes("X") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
        })
        .nextNode() as Text;
      selection.setBaseAndExtent(tail, tail.data.indexOf("X") + 1, firstText(), 0);
      progress.complete = true;
      notify();
      expect(paragraph.textContent).toBe("A👩🏽‍💻éZXY");
      expect(selection.toString()).toBe("A👩🏽‍💻éZX");
      expect(paragraph.style.display).toBe("");
    } finally {
      selection.removeAllRanges();
    }
  },
);
