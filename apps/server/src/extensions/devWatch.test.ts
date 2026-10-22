// @effect-diagnostics nodeBuiltinImport:off -- The regression uses isolated filesystem metadata.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { sourceSnapshot } from "./devWatch.ts";

it("ignores access-time events and same-byte writes but detects source edits, creation and deletion", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "source-watch-"));
  try {
    const file = NodePath.join(root, "source.ts");
    NodeFS.writeFileSync(file, "export const value = 1;\n");
    const snapshot = sourceSnapshot([root]);
    const stat = NodeFS.statSync(file);
    NodeFS.utimesSync(file, 0, stat.mtimeMs / 1000);
    NodeFS.readFileSync(file);
    expect(snapshot.refresh(file)).toBe(false);
    NodeFS.writeFileSync(file, "export const value = 1;\n");
    expect(snapshot.refresh(file)).toBe(false);
    NodeFS.writeFileSync(file, "export const value = 2;\n");
    expect(snapshot.refresh(file)).toBe(true);
    expect(snapshot.refresh(file)).toBe(false);
    const added = NodePath.join(root, "added.ts");
    NodeFS.writeFileSync(added, "export {};\n");
    expect(snapshot.refresh(root)).toBe(true);
    NodeFS.unlinkSync(added);
    expect(snapshot.refresh(root)).toBe(true);
    expect(snapshot.refresh(root)).toBe(false);
    NodeFS.mkdirSync(NodePath.join(root, "node_modules"));
    NodeFS.writeFileSync(NodePath.join(root, "node_modules", "cache.json"), "{}");
    NodeFS.writeFileSync(NodePath.join(root, "cache.tsbuildinfo"), "{}");
    expect(snapshot.refresh(root)).toBe(false);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
