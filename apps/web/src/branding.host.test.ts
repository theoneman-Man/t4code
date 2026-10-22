// @effect-diagnostics nodeBuiltinImport:off - Fixture builds use isolated temporary files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { build } from "vite-plus";
import { expect, it } from "vite-plus/test";
import { brandingPlugin } from "../vite/branding";
import { loadHostBranding } from "@t3tools/extension-sdk/branding/node";

function fixture() {
  const base = NodePath.resolve(NodeOS.tmpdir());
  const root = NodeFS.mkdtempSync(NodePath.join(base, "branding-web-"));
  const html = NodeFS.readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(
    '<script type="module" src="/src/bootstrap.ts"></script>',
    '<script type="module" src="/entry.ts"></script>',
  );
  NodeFS.writeFileSync(NodePath.join(root, "index.html"), html);
  NodeFS.writeFileSync(NodePath.join(root, "entry.ts"), 'console.log("fixture");');
  return {
    root,
    html,
    [Symbol.dispose]() {
      if (NodePath.dirname(NodePath.resolve(root)) !== base || !root.includes("branding-web-"))
        throw new Error("Unexpected fixture root.");
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("leaves upstream HTML exactly unchanged without host config", async () => {
  using files = fixture();
  NodeFS.writeFileSync(NodePath.join(files.root, "apple-touch-icon.png"), "upstream-splash");
  const options = {
    configFile: false as const,
    root: files.root,
    logLevel: "silent" as const,
    build: { write: false, minify: false as const },
  };
  const upstream = await build(options);
  const branded = await build({
    ...options,
    plugins: [brandingPlugin(loadHostBranding(files.root))],
  });
  if (
    Array.isArray(upstream) ||
    !("output" in upstream) ||
    Array.isArray(branded) ||
    !("output" in branded)
  )
    throw new Error("Expected build output.");
  expect(branded.output).toEqual(upstream.output);
});

it("builds title, splash, favicon, logo and layered CSS from external host files", async () => {
  using files = fixture();
  NodeFS.writeFileSync(
    NodePath.join(files.root, "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  NodeFS.writeFileSync(NodePath.join(files.root, "favicon.png"), "fixture-png");
  NodeFS.writeFileSync(
    NodePath.join(files.root, "tile.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
  );
  NodeFS.writeFileSync(
    NodePath.join(files.root, "extra.css"),
    '.host-sample { color: red; background: url("./tile.svg"); }',
  );
  const output = await build({
    configFile: false,
    root: files.root,
    logLevel: "silent",
    plugins: [
      brandingPlugin({
        appName: "Sample",
        stageLabel: "Local",
        logo: NodePath.join(files.root, "logo.svg"),
        favicon: NodePath.join(files.root, "favicon.png"),
        css: NodePath.join(files.root, "extra.css"),
        tokens: { "--primary": "red" },
      }),
    ],
    build: { write: false, minify: false, cssMinify: false, assetsInlineLimit: 0 },
  });
  if (Array.isArray(output) || !("output" in output)) throw new Error("Expected one build output.");
  const html = output.output.find((entry) => entry.fileName === "index.html");
  if (html?.type !== "asset") throw new Error("Missing HTML output.");
  expect(html.source).toContain("<title>Sample (Local)</title>");
  expect(html.source).toContain('alt="Sample"');
  expect(html.source).toMatch(/assets\/logo-[^" ]+\.svg/);
  expect(html.source).toMatch(/assets\/favicon-[^" ]+\.png/);
  expect(html.source).not.toContain("__VITE_ASSET__");
  expect(html.source).not.toContain(files.root);
  const css = output.output
    .flatMap((entry) =>
      entry.type === "asset" && entry.fileName.endsWith(".css") ? [entry.source] : [],
    )
    .join("\n");
  expect(css).toContain("@layer host-branding");
  expect(css).toMatch(/--primary:\s*red !important/);
  expect(css).toContain(".host-sample");
  expect(css).toMatch(/tile-[^" ]+\.svg/);
});
