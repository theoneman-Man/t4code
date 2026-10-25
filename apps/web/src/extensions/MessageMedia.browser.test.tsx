import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { render } from "../../test/render";
import { ExtensionMessageMedia } from "./MessageMedia";
import { ExpandedImageDialog } from "../components/chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../components/chat/ExpandedImagePreview";

const assets = vi.hoisted(() => ({ state: vi.fn(), refresh: vi.fn() }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (...args: unknown[]) => assets.state(...args),
  useAssetUrlRefresh: (...args: unknown[]) => assets.refresh(...args),
}));

it("opens an original image from an extension thumbnail in the host preview", async () => {
  const thumbnail =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'/%3E";
  const original =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'/%3E";
  assets.state.mockReset().mockReturnValue({ _tag: "Success", url: thumbnail });
  assets.refresh.mockReset().mockReturnValue(async () => original);
  function View() {
    const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
    return (
      <>
        <ExtensionMessageMedia
          environmentId={EnvironmentId.make("env")}
          media={{
            extensionId: "sample",
            items: [{ path: "/files/gate.png?v=one", name: "Gate" }],
          }}
          onExpand={setPreview}
        />
        {preview ? (
          <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
        ) : null}
      </>
    );
  }
  await using screen = await render(<View />);
  await expect
    .element(screen.getByRole("img", { name: "Gate", exact: true }))
    .toHaveAttribute("src", thumbnail);
  await screen.getByRole("button", { name: "Preview Gate", exact: true }).click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await vi.waitFor(() => {
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe(original);
  });
  expect(assets.state).toHaveBeenCalledWith("env", {
    _tag: "extension-media",
    extensionId: "sample",
    path: "/files/gate.png?v=one&w=512",
  });
  expect(assets.refresh).toHaveBeenCalledWith("env", {
    _tag: "extension-media",
    extensionId: "sample",
    path: "/files/gate.png?v=one",
  });
});

it("renders duplicate paths as distinct media entries without key collisions", async () => {
  assets.state.mockReset().mockReturnValue({ _tag: "Success", url: "data:image/png;base64," });
  assets.refresh.mockReset().mockReturnValue(async () => null);
  using errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await using screen = await render(
    <ExtensionMessageMedia
      environmentId={EnvironmentId.make("env")}
      media={{
        extensionId: "sample",
        items: [
          { path: "/gate.jpg?w=64&w=1600", name: "First" },
          { path: "/gate.jpg?w=64&w=1600", name: "Second" },
        ],
      }}
      onExpand={() => {}}
    />,
  );
  await expect.element(screen.getByRole("img", { name: "First", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "Second", exact: true })).toBeVisible();
  expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key|unique.*key/i);
  expect(assets.state).toHaveBeenCalledWith("env", {
    _tag: "extension-media",
    extensionId: "sample",
    path: "/gate.jpg?w=512",
  });
});
