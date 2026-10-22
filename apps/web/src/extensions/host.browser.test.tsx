import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render, act, stubGlobal } from "../../test/render";
import { WorkspaceSwitcher, ExtensionWorkspaceOutlet } from "./Workspace";
import { ExtensionNavigationBridge } from "./navigation";
import { SlotHost } from "./SlotHost";
import { extensionSlots } from "./registry";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  useExtFetch,
  useExtEvents,
} from "@t3tools/extension-sdk";
import { createEventStreams, extensionEventStreams } from "./events";
import { refreshExtensionStatus } from "./status";

vi.mock("virtual:t4-extensions", async () => ({
  default: [
    (
      await import("../../../../packages/extension-sdk/fixtures/sample/web/index.ts?extension-fixture")
    ).default,
  ],
}));
vi.mock("./hostContext", () => ({ useHostExtContext: () => ({ environmentId: "test-env" }) }));
vi.mock("./http", () => ({
  extensionPath: (id: string, path: string) => `/ext/${id}${path}`,
  fetchEnvironmentPath: (_environmentId: string, path: string, init?: RequestInit) =>
    globalThis.fetch(path, init),
}));

async function selectWorkspace(name: string) {
  const trigger = page.getByRole("button", { name: "Switch workspace" });
  await expect.element(trigger).toBeVisible();
  await trigger.click();
  const popup = page.getByRole("menu");
  await expect.element(popup).toBeVisible();
  const item = page.getByRole("menuitem", { name, exact: true });
  await expect.element(item).toBeVisible();
  await item.click();
  await expect.element(popup).not.toBeInTheDocument();
}

function fixtureBackend() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/extensions")
      return Promise.resolve(Response.json({ extensions: [{ id: "sample", backend: "ready" }] }));
    if (path === "/ext/sample/hello")
      return Promise.resolve(Response.json({ message: "hello from sample" }));
    if (path === "/ext/sample/events")
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
        ),
      );
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  return {
    fetch,
    get controller() {
      return controller;
    },
  };
}

function FixtureHost() {
  return (
    <>
      <ExtensionNavigationBridge />
      <WorkspaceSwitcher />
      <ExtensionWorkspaceOutlet>
        <p>Chat content</p>
      </ExtensionWorkspaceOutlet>
    </>
  );
}

it("opens a fixture workspace and receives proxy data and pushed ticks", async () => {
  const backend = fixtureBackend();
  using _fetch = stubGlobal("fetch", backend.fetch);
  await using screen = await render(<FixtureHost />);
  await selectWorkspace("Sample workspace");
  await expect.element(screen.getByText("hello from sample")).toBeVisible();
  await vi.waitFor(() => expect(backend.controller).toBeDefined());
  await act(() =>
    backend.controller!.enqueue(new TextEncoder().encode('id: 1\nevent: tick\ndata: {"n":7}\n\n')),
  );
  await expect.element(screen.getByText("Last tick: 7")).toBeVisible();
});

it("retains a fixture draft and event stream when switching away and back", async () => {
  const backend = fixtureBackend();
  using _fetch = stubGlobal("fetch", backend.fetch);
  await using screen = await render(<FixtureHost />, {
    router: "/#ext-workspace=sample%3Aworkspace",
  });
  await expect.element(screen.getByRole("textbox", { name: "Sample draft" })).toBeVisible();
  await screen.getByRole("textbox", { name: "Sample draft" }).fill("retained draft");
  await vi.waitFor(() => expect(backend.controller).toBeDefined());
  await selectWorkspace("Chat");
  await expect.element(screen.getByText("Chat content")).toBeVisible();
  await selectWorkspace("Sample workspace");
  await expect
    .element(screen.getByRole("textbox", { name: "Sample draft" }))
    .toHaveValue("retained draft");
  expect(backend.fetch.mock.calls.filter(([path]) => path === "/ext/sample/events")).toHaveLength(
    1,
  );
});

it("keeps the chosen workspace across the initial draft redirect and still allows Chat and history", async () => {
  const backend = fixtureBackend();
  using _fetch = stubGlobal("fetch", backend.fetch);
  await using screen = await render(<FixtureHost />);
  await selectWorkspace("Sample workspace");
  await expect.element(screen.getByText("hello from sample")).toBeVisible();
  await act(() =>
    screen.router!.navigate({
      to: "/draft/$draftId",
      params: { draftId: "initial" },
      replace: true,
    }),
  );
  await expect.element(screen.getByText("hello from sample")).toBeVisible();
  expect(screen.router!.state.location.pathname).toBe("/draft/initial");
  expect(screen.router!.state.location.hash).toBe("ext-workspace=sample%3Aworkspace");
  await selectWorkspace("Chat");
  await expect.element(screen.getByText("Chat content")).toBeVisible();
  await act(() => screen.router!.history.back());
  await expect.element(screen.getByText("hello from sample")).toBeVisible();
  await act(() => screen.router!.history.forward());
  await expect.element(screen.getByText("Chat content")).toBeVisible();
});

it("contains render failures at the slot boundary", async () => {
  const entry = extensionSlots[0]!;
  const Throwing = () => {
    throw new Error("fixture failure");
  };
  await using errorScreen = await render(
    <SlotHost
      entry={{ ...entry, slot: { ...entry.slot, component: Throwing } }}
      context={{ environmentId: "test-env" }}
      active
      status={{ id: "sample", backend: "none" }}
    />,
  );
  await expect
    .element(errorScreen.getByRole("alert"))
    .toHaveTextContent("This extension view could not be displayed.");
});

function PortalView() {
  return (
    <Dialog defaultOpen>
      <DialogPopup>
        <DialogTitle>Scoped popup</DialogTitle>
      </DialogPopup>
    </Dialog>
  );
}

it("scopes SDK popup portal roots to the owning extension", async () => {
  const entry = extensionSlots[0]!;
  await using screen = await render(
    <SlotHost
      entry={{ ...entry, slot: { ...entry.slot, component: PortalView } }}
      context={{ environmentId: "test-env" }}
      active
      status={{ id: "sample", backend: "none" }}
    />,
  );
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await vi.waitFor(() => {
    const portal = document.body.querySelector(
      ':scope > .t4-ext-sample[data-extension-id="sample"]',
    );
    expect(portal?.querySelector('[role="dialog"]')).toBeTruthy();
  });
  await screen.unmount();
});

function StatusView() {
  const fetch = useExtFetch();
  useExtEvents("tick", () => {});
  return <button onClick={() => void fetch("/hello")}>Request backend</button>;
}

it("refreshes backend status after a proxied 503", async () => {
  let statusReads = 0;
  const fetch = vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/api/extensions") {
      statusReads++;
      return Promise.resolve(
        Response.json({
          extensions: [{ id: "sample", backend: statusReads === 1 ? "ready" : "restarting" }],
        }),
      );
    }
    if (String(input) === "/ext/sample/events")
      return Promise.resolve(new Response(new ReadableStream()));
    return Promise.resolve(new Response(null, { status: 503 }));
  });
  using _fetch = stubGlobal("fetch", fetch);
  const entry = extensionSlots[0]!;
  await using screen = await render(
    <SlotHost
      entry={{ ...entry, slot: { ...entry.slot, component: StatusView } }}
      context={{ environmentId: "test-env" }}
      active
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Request backend" })).toBeVisible();
  await screen.getByRole("button", { name: "Request backend" }).click();
  await expect.element(screen.getByText("Extension restarting.", { exact: true })).toBeVisible();
  expect(statusReads).toBe(2);
});

it("refreshes backend status when the shared event stream reconnects", async () => {
  let statusReads = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let retry!: () => void;
  let scheduled!: () => void;
  const pendingRetry = new Promise<void>((resolve) => {
    scheduled = resolve;
  });
  const streams = createEventStreams((run) => {
    retry = run;
    scheduled();
    return () => {};
  }, refreshExtensionStatus);
  using _subscribe = vi
    .spyOn(extensionEventStreams, "subscribe")
    .mockImplementation(streams.subscribe);
  const fetch = vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/ext/sample/events")
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
        ),
      );
    statusReads++;
    return Promise.resolve(
      Response.json({
        extensions: [{ id: "sample", backend: statusReads === 1 ? "ready" : "restarting" }],
      }),
    );
  });
  using _fetch = stubGlobal("fetch", fetch);
  const entry = extensionSlots[0]!;
  await using screen = await render(
    <SlotHost
      entry={{ ...entry, slot: { ...entry.slot, component: StatusView } }}
      context={{ environmentId: "test-env" }}
      active
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Request backend" })).toBeVisible();
  await act(() => refreshExtensionStatus("another-env:sample"));
  expect(statusReads).toBe(1);
  await vi.waitFor(() => expect(controller).toBeDefined());
  await act(() => controller!.close());
  await pendingRetry;
  await act(() => retry());
  await expect.element(screen.getByText("Extension restarting.", { exact: true })).toBeVisible();
  expect(statusReads).toBe(2);
});
