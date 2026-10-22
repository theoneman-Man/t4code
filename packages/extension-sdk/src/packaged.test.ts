import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { loadPackagedExtensions } from "./packaged.ts";

const fixture = () => {
  const resources = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "packaged-extensions-"));
  const root = NodePath.join(resources, "extensions", "sample-tool");
  NodeFS.mkdirSync(root, { recursive: true });
  const index = NodePath.join(resources, "extensions", "index.json");
  const manifestFile = NodePath.join(root, "t4-extension.json");
  const manifest = {
    id: "sample-tool",
    sdk: 1,
    backend: {
      command: ["./runtime/node.exe", "--import", "tsx", "./server.mjs", "literal"],
      cwd: "./pipeline",
      protocol: 1,
      dataDir: "./default-data",
    },
  };
  NodeFS.writeFileSync(
    index,
    JSON.stringify({ version: 1, extensions: [{ id: manifest.id, dir: "sample-tool" }] }),
  );
  NodeFS.writeFileSync(manifestFile, JSON.stringify(manifest));
  return {
    resources,
    root,
    index,
    manifestFile,
    manifest,
    [Symbol.dispose]() {
      NodeFS.rmSync(resources, { recursive: true, force: true });
    },
  };
};

it("resolves every ./ command entry and cwd against the payload, with a normalized data override", () => {
  using f = fixture();
  const dataDir = NodePath.join(f.resources, "writable-data");
  const [extension] = loadPackagedExtensions(f.resources, {
    T4_EXT_DATA_DIR__SAMPLE_TOOL: dataDir,
  });
  expect(extension?.root).toBe(f.root);
  expect(extension?.manifest.backend?.command).toEqual([
    NodePath.join(f.root, "runtime/node.exe"),
    "--import",
    "tsx",
    NodePath.join(f.root, "server.mjs"),
    "literal",
  ]);
  expect(extension?.backendCwd).toBe(NodePath.join(f.root, "pipeline"));
  expect(extension?.dataDir).toBe(dataDir);
  expect(JSON.parse(NodeFS.readFileSync(f.manifestFile, "utf8"))).toEqual(f.manifest);
});

it("retains ordinary command entries and resolves dot cwd and the manifest data default", () => {
  using f = fixture();
  NodeFS.writeFileSync(
    f.manifestFile,
    JSON.stringify({
      ...f.manifest,
      backend: { ...f.manifest.backend, command: ["node", "server.mjs"], cwd: "." },
    }),
  );
  const [extension] = loadPackagedExtensions(f.resources, {});
  expect(extension?.manifest.backend?.command).toEqual(["node", "server.mjs"]);
  expect(extension?.backendCwd).toBe(f.root);
  expect(extension?.dataDir).toBe(NodePath.join(f.root, "default-data"));
});

it("loads all listed manifests, including extensions without a backend", () => {
  using f = fixture();
  const other = NodePath.join(f.resources, "extensions", "viewer");
  NodeFS.mkdirSync(other);
  NodeFS.writeFileSync(
    NodePath.join(other, "t4-extension.json"),
    JSON.stringify({ id: "viewer", sdk: 1, web: "./web.ts" }),
  );
  NodeFS.writeFileSync(
    f.index,
    JSON.stringify({
      version: 1,
      extensions: [
        { id: "sample-tool", dir: "sample-tool" },
        { id: "viewer", dir: "viewer" },
      ],
    }),
  );
  expect(loadPackagedExtensions(f.resources, {}).map((extension) => extension.manifest.id)).toEqual(
    ["sample-tool", "viewer"],
  );
});

it("treats a missing or malformed index as an empty installation", () => {
  using f = fixture();
  NodeFS.unlinkSync(f.index);
  expect(loadPackagedExtensions(f.resources, {})).toEqual([]);
  NodeFS.writeFileSync(f.index, "{");
  expect(loadPackagedExtensions(f.resources, {})).toEqual([]);
  NodeFS.writeFileSync(f.index, JSON.stringify({ version: 2, extensions: [] }));
  expect(loadPackagedExtensions(f.resources, {})).toEqual([]);
  NodeFS.writeFileSync(f.index, JSON.stringify({ version: 1, extensions: "sample-tool" }));
  expect(loadPackagedExtensions(f.resources, {})).toEqual([]);
});

it("rejects the whole index for invalid entries, duplicate ids or escaping directories", () => {
  using f = fixture();
  for (const extensions of [
    [null],
    [{ id: "../bad", dir: "sample-tool" }],
    [{ id: "sample-tool", dir: "../outside" }],
    [{ id: "sample-tool", dir: NodePath.resolve(f.root) }],
    [
      { id: "sample-tool", dir: "sample-tool" },
      { id: "sample-tool", dir: "sample-tool" },
    ],
  ]) {
    NodeFS.writeFileSync(f.index, JSON.stringify({ version: 1, extensions }));
    expect(loadPackagedExtensions(f.resources, {})).toEqual([]);
  }
});

it("disables extensions for a missing, invalid or mismatched manifest", () => {
  using f = fixture();
  NodeFS.unlinkSync(f.manifestFile);
  expect(loadPackagedExtensions(f.resources, {})).toEqual([]);
  NodeFS.writeFileSync(f.manifestFile, "{");
  expect(loadPackagedExtensions(f.resources, {})).toEqual([]);
  NodeFS.writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest, id: "different" }));
  expect(loadPackagedExtensions(f.resources, {})).toEqual([]);
  NodeFS.writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest, sdk: 2 }));
  expect(loadPackagedExtensions(f.resources, {})).toEqual([]);
});
