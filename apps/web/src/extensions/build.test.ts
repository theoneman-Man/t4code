// @effect-diagnostics nodeBuiltinImport:off - The Vite fixture builds into an isolated temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { build } from "vite-plus";
import { expect, it } from "vite-plus/test";
import { extensionsPlugin } from "../../vite/extensions";

function fixture() {
  const base = NodePath.resolve(NodeOS.tmpdir());
  const root = NodeFS.mkdtempSync(NodePath.join(base, "extension-web-"));
  const write = (path: string, content: string) => {
    const target = NodePath.join(root, path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
  };
  return {
    root,
    write,
    [Symbol.dispose]() {
      if (
        NodePath.dirname(NodePath.resolve(root)) !== base ||
        !NodePath.basename(root).startsWith("extension-web-")
      )
        throw new Error("Unexpected fixture directory.");
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

function buildFixture(root: string) {
  return build({
    configFile: false,
    root: NodePath.resolve(import.meta.dirname, "../.."),
    logLevel: "silent",
    plugins: [extensionsPlugin(root)],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: NodePath.join(root, "entry.ts") },
    },
  });
}

it("builds an external extension with view code and own dependencies only in a lazy chunk", async () => {
  using files = fixture();
  files.write("t4.extensions.json", '["./sample"]');
  files.write(
    "sample/t4-extension.json",
    JSON.stringify({ id: "sample", sdk: 1, web: "./web/index.ts", routes: [] }),
  );
  files.write("sample/web/index.ts", 'export { default } from "./module";');
  files.write(
    "sample/web/module.ts",
    'import { lazy } from "react"; import { slots } from "./slots"; const View = lazy(() => import("./heavy")); const Icon = () => null; export default { id: "sample", sdk: 1, slots: slots(View, Icon) };',
  );
  files.write(
    "sample/web/slots.ts",
    'export const slots = (component, icon) => [{kind:"workspace",id:"main",title:"Sample title",icon,component,keepAlive:true}];',
  );
  files.write(
    "sample/web/heavy.ts",
    'import { message } from "fixture-dependency"; import "./view.css"; globalThis.console.log(message); export default () => null;',
  );
  files.write("sample/web/view.css", ".t4-ext-sample { color: red; }");
  files.write(
    "sample/node_modules/fixture-dependency/package.json",
    '{"name":"fixture-dependency","type":"module","exports":"./index.js"}',
  );
  files.write(
    "sample/node_modules/fixture-dependency/index.js",
    'export const message = "view-only-code";',
  );
  files.write(
    "entry.ts",
    'import extensions from "virtual:t4-extensions"; globalThis.console.log(extensions);',
  );
  const result = await buildFixture(files.root);
  if (Array.isArray(result) || !("output" in result))
    throw new Error("Expected one fixture build.");
  const chunks = result.output.filter((entry) => entry.type === "chunk");
  const entry = chunks.find((chunk) => chunk.isEntry)!;
  expect(entry.code).toContain("Sample title");
  expect(entry.code).not.toContain("view-only-code");
  expect(chunks.some((chunk) => !chunk.isEntry && chunk.code.includes("view-only-code"))).toBe(
    true,
  );
});

it.each([
  { id: "different", sdk: 1, message: /module id must be/ },
  { id: "sample", sdk: 2, message: /sdk: 1/ },
])("fails the build for web module $id SDK $sdk mismatches", async ({ id, sdk, message }) => {
  using files = fixture();
  files.write("t4.extensions.json", '["./sample"]');
  files.write(
    "sample/t4-extension.json",
    JSON.stringify({ id: "sample", sdk: 1, web: "./web/index.ts", routes: [] }),
  );
  files.write(
    "sample/web/index.ts",
    `export default { id: ${JSON.stringify(id)}, sdk: ${sdk}, slots: [] };`,
  );
  files.write(
    "entry.ts",
    'import extensions from "virtual:t4-extensions"; globalThis.console.log(extensions);',
  );
  await expect(buildFixture(files.root)).rejects.toThrow(message);
});
