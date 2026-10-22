import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  hostHomeDirName,
  hostIdentity,
  hostScheme,
  parseHostBranding,
  resolveHostAppBranding,
} from "./branding";
import { loadHostBranding } from "./brandingNode";

it("keeps upstream identity unchanged when the file is missing", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "host-branding-"));
  try {
    const config = loadHostBranding(root);
    expect(config).toBeNull();
    for (const stageLabel of ["Dev", "Beta", "Nightly"]) {
      const upstream = { baseName: "T3 Code", stageLabel, displayName: `T3 Code (${stageLabel})` };
      expect(resolveHostAppBranding(upstream, config)).toBe(upstream);
    }
    expect(hostHomeDirName(config)).toBe(".t3");
    expect(hostIdentity("com.t3tools.t3code", false, config)).toBe("com.t3tools.t3code");
    expect(hostIdentity("com.t3tools.t3code.dev", true, config)).toBe("com.t3tools.t3code.dev");
    expect(hostScheme("t3code", false, config)).toBe("t3code");
    expect(hostScheme("t3code-dev", true, config)).toBe("t3code-dev");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("resolves host assets relative to the config and separates development identity", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "host-branding-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(root, "t4.branding.json"),
      JSON.stringify({
        appName: "T4",
        stageLabel: "Local",
        appId: "dev.example.t4",
        scheme: "t4",
        homeDirName: ".t4",
        logo: "./logo.svg",
      }),
    );
    const config = loadHostBranding(root);
    expect(config?.logo).toBe(NodePath.join(root, "logo.svg"));
    expect(
      resolveHostAppBranding(
        { baseName: "T3 Code", stageLabel: "Dev", displayName: "T3 Code (Dev)" },
        config,
      ),
    ).toEqual({ baseName: "T4", stageLabel: "Local", displayName: "T4 (Local)" });
    expect(hostIdentity("upstream", true, config)).toBe("dev.example.t4.dev");
    expect(hostScheme("upstream", true, config)).toBe("t4-dev");
    expect(hostHomeDirName(config)).toBe(".t4");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects malformed config and CSS token injection", () => {
  for (const input of [
    null,
    [],
    { homeDirName: "../other" },
    { scheme: "Bad Scheme" },
    { tokens: { color: "red" } },
    { tokens: { "--primary": "red; } body {" } },
  ]) {
    expect(() => parseHostBranding(input)).toThrow();
  }
  expect(parseHostBranding({ tokens: { "--primary": "oklch(0.7 0.1 20)" } }).tokens).toEqual({
    "--primary": "oklch(0.7 0.1 20)",
  });
});
