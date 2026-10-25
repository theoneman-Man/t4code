import { expect, it, vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  createReloadController,
  isBackendSource,
  probeBackendBusy,
  watchBackendSources,
} from "./devReload.ts";

it("debounces changes and counts unique files", async () => {
  vi.useFakeTimers();
  const reload = vi.fn(),
    log = vi.fn();
  const controller = createReloadController({ busy: async () => ({ busy: false }), reload, log });
  try {
    controller.changed("a.ts");
    await vi.advanceTimersByTimeAsync(500);
    controller.changed("a.ts");
    controller.changed("b.ts");
    await vi.advanceTimersByTimeAsync(749);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledExactlyOnceWith(2);
    expect(log).toHaveBeenCalledExactlyOnceWith("reloading backend (2 changed files)");
  } finally {
    controller.close();
    vi.useRealTimers();
  }
});

it("keeps a single pending reload while busy, logs deferral once, and includes later changes", async () => {
  vi.useFakeTimers();
  const busy = vi.fn().mockResolvedValue({ busy: true, reason: "run-1: step-1" });
  const reload = vi.fn(),
    log = vi.fn();
  const controller = createReloadController({ busy, reload, log });
  try {
    controller.changed("a.ts");
    await vi.advanceTimersByTimeAsync(750);
    controller.changed("b.ts");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reload).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith("reload deferred: run-1: step-1");
    busy.mockResolvedValue({ busy: false });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reload).toHaveBeenCalledExactlyOnceWith(2);
  } finally {
    controller.close();
    vi.useRealTimers();
  }
});

it("does not restart when a busy probe fails and cancels pending work on close", async () => {
  vi.useFakeTimers();
  const reload = vi.fn();
  const controller = createReloadController({
    busy: async () => {
      throw new Error("offline");
    },
    reload,
    log: vi.fn(),
  });
  try {
    controller.changed("a.ts");
    await vi.advanceTimersByTimeAsync(750);
    expect(reload).not.toHaveBeenCalled();
    controller.close();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reload).not.toHaveBeenCalled();
  } finally {
    controller.close();
    vi.useRealTimers();
  }
});

it.each([
  "node_modules/pkg/a.ts",
  ".git/index",
  "dist/a.js",
  "data/run.json",
  "pipeline/data/run.json",
  "logs/a.log",
  "runs/run.json",
  "x.tsbuildinfo",
  "extension.log",
  "state.sqlite",
  "state.sqlite-wal",
])("ignores generated data: %s", (file) => {
  expect(isBackendSource(file)).toBe(false);
});
it("accepts sources, relative dirs and globs while excluding the actual data directory", () => {
  expect(isBackendSource("pipeline/lean/library/books/a.json")).toBe(true);
  expect(isBackendSource("source.ts", ["./"])).toBe(true);
  expect(isBackendSource("pipeline/lean/main.ts", ["./pipeline/lean"])).toBe(true);
  expect(isBackendSource("pipeline/lean/main.ts", ["pipeline/**/*.ts"])).toBe(true);
  expect(isBackendSource("web/main.tsx", ["pipeline/lean"])).toBe(false);
  expect(isBackendSource("private-state/a.json", undefined, "private-state")).toBe(false);
});

it.each([404, 405])("reloads without an optional busy endpoint (%s)", async (status) => {
  using fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
  expect(await probeBackendBusy({ url: "http://localhost", token: "fixture" })).toEqual({
    busy: false,
  });
  expect(fetch).toHaveBeenCalledWith(
    "http://localhost/.t4/busy",
    expect.objectContaining({ headers: { authorization: "Bearer fixture" }, redirect: "error" }),
  );
});
it("does not subscribe or read the filesystem outside development", () => {
  const watcher = watchBackendSources({
    development: false,
    root: "missing",
    dataDir: "missing",
    busy: async () => ({ busy: false }),
    reload: vi.fn(),
    log: vi.fn(),
  });
  expect(() => watcher.close()).not.toThrow();
});

it("detects changed bytes through the native watcher", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "extension-watch-"));
  NodeFS.writeFileSync(NodePath.join(root, "source.ts"), "before");
  let reloaded!: (count: number) => void;
  const done = new Promise<number>((resolve) => {
    reloaded = resolve;
  });
  const watcher = watchBackendSources({
    development: true,
    root,
    dataDir: NodePath.join(root, "data"),
    busy: async () => ({ busy: false }),
    reload: reloaded,
    log: vi.fn(),
  });
  try {
    NodeFS.writeFileSync(NodePath.join(root, "source.ts"), "after");
    expect(await done).toBe(1);
  } finally {
    watcher.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
