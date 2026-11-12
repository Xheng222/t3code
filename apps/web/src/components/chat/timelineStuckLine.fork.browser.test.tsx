import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { observeStuckLine } from "./timelineStuckLine.fork";

it("marks a line stuck at the top until the end of its row pushes it out", async () => {
  // This exercises the observer without the timeline around it.
  await using screen = await render(<div data-testid="root" />, { router: false });
  const root = screen.container.querySelector<HTMLDivElement>("[data-testid=root]")!;
  root.style.cssText = "height: 200px; overflow-y: auto;";
  const row = document.createElement("div");
  row.style.cssText = "margin-top: 100px; height: 600px;";
  const line = document.createElement("div");
  line.style.cssText = "position: sticky; top: 0; height: 24px;";
  row.append(line);
  const after = document.createElement("div");
  after.style.height = "800px";
  root.append(row, after);
  using cleanup = new DisposableStack();
  cleanup.defer(observeStuckLine(line, root));
  const stuck = () => [line.hasAttribute("data-stuck"), root.hasAttribute("data-entry-stuck")];
  root.scrollTop = 300;
  await vi.waitFor(() => expect(stuck()).toEqual([true, true]));
  root.scrollTop = 750;
  await vi.waitFor(() => expect(stuck()).toEqual([false, false]));
});
