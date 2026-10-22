import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  ExtensionManifestError,
  matchExtensionRoute,
  parseExtensionList,
  parseExtensionManifest,
} from "./manifest.ts";
import { loadExtensions } from "./node.ts";

const manifest = {
  id: "sample",
  sdk: 1,
  web: "./web/index.ts",
  backend: { command: ["node", "server.js"], cwd: ".", protocol: 1, dataDir: "./data" },
  routes: [
    { method: "GET", path: "/**", scope: "read" },
    { method: "*", path: "/**", scope: "operate" },
  ],
};

describe("parseExtensionManifest", () => {
  it("accepts the frozen manifest shape", () => {
    expect(parseExtensionManifest(manifest)).toEqual(manifest);
  });

  it("rejects an SDK mismatch", () => {
    expect(() => parseExtensionManifest({ ...manifest, sdk: 2 })).toThrow(/host provides sdk 1/);
  });

  it("rejects ids that are not path-safe", () => {
    expect(() => parseExtensionManifest({ ...manifest, id: "../x" })).toThrow(
      ExtensionManifestError,
    );
  });

  it("rejects routes without a backend and non-final globstars", () => {
    expect(() => parseExtensionManifest({ ...manifest, backend: undefined })).toThrow(
      /routes require a backend/,
    );
    expect(() =>
      parseExtensionManifest({
        ...manifest,
        routes: [{ method: "GET", path: "/**/x", scope: "read" }],
      }),
    ).toThrow(/final/);
  });
});

describe("matchExtensionRoute", () => {
  const { routes } = parseExtensionManifest({
    ...manifest,
    routes: [{ method: "POST", path: "/api/*/validate", scope: "read" }, ...manifest.routes],
  });

  it("uses the first matching route", () => {
    expect(matchExtensionRoute(routes, "get", "/api/runs")?.scope).toBe("read");
    expect(matchExtensionRoute(routes, "POST", "/api/library/validate")?.scope).toBe("read");
    expect(matchExtensionRoute(routes, "POST", "/api/runs")?.scope).toBe("operate");
  });

  it("returns undefined for undeclared routes", () => {
    const only = parseExtensionManifest({
      ...manifest,
      routes: [{ method: "GET", path: "/events", scope: "read" }],
    }).routes;
    expect(matchExtensionRoute(only, "GET", "/events")).toBeDefined();
    expect(matchExtensionRoute(only, "GET", "/events/x")).toBeUndefined();
    expect(matchExtensionRoute(only, "POST", "/events")).toBeUndefined();
  });
});

describe("extension list", () => {
  it("accepts string and object entries", () => {
    expect(parseExtensionList({ extensions: ["../a", { path: "../b", dataDir: "d" }] })).toEqual([
      { path: "../a" },
      { path: "../b", dataDir: "d" },
    ]);
  });

  it("loads nothing when the list file is absent", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "ext-sdk-"));
    expect(loadExtensions(dir)).toEqual([]);
    FS.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves folders and rejects duplicate ids", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "ext-sdk-"));
    const ext = Path.join(dir, "ext");
    FS.mkdirSync(ext);
    FS.writeFileSync(Path.join(ext, "t4-extension.json"), JSON.stringify(manifest));
    FS.writeFileSync(
      Path.join(dir, "t4.extensions.json"),
      JSON.stringify([{ path: "./ext", dataDir: "./copied" }]),
    );
    const [loaded] = loadExtensions(dir);
    expect(loaded?.root).toBe(ext);
    expect(loaded?.webEntry).toBe(Path.join(ext, "web", "index.ts"));
    expect(loaded?.dataDir).toBe(Path.join(dir, "copied"));

    FS.writeFileSync(Path.join(dir, "t4.extensions.json"), JSON.stringify(["./ext", "ext"]));
    expect(() => loadExtensions(dir)).toThrow(/duplicate extension id/);
    FS.rmSync(dir, { recursive: true, force: true });
  });
});
