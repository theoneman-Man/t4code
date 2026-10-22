// @effect-diagnostics nodeBuiltinImport:off - Build configuration reads local host assets before an Effect runtime exists.
import * as NodePath from "node:path";
import { loadHostBranding } from "./brandingNode.ts";
import { resolveHostAppBranding, type HostBranding } from "./branding.ts";

export function hostProductName(upstream: string, config = loadHostBranding()) {
  if (!config) return upstream;
  return resolveHostAppBranding(
    {
      baseName: "T3 Code",
      stageLabel: upstream.includes("Nightly") ? "Nightly" : "Beta",
      displayName: upstream,
    },
    config,
  ).displayName;
}

export function hostBuildConfig(upstream: Record<string, unknown>, config = loadHostBranding()) {
  if (!config) return upstream;
  const result: Record<string, unknown> = { ...upstream, appId: config.appId ?? upstream.appId };
  if (config.appName && typeof result.artifactName === "string")
    result.artifactName = result.artifactName.replace(
      /^T3-Code/,
      config.appName.replace(/[^a-zA-Z0-9_-]+/g, "-"),
    );
  if (result.linux && typeof result.linux === "object" && config.appId) {
    const linux = result.linux;
    const desktop =
      "desktop" in linux && linux.desktop && typeof linux.desktop === "object" ? linux.desktop : {};
    const entry =
      "entry" in desktop && desktop.entry && typeof desktop.entry === "object" ? desktop.entry : {};
    result.linux = {
      ...linux,
      executableName: config.scheme ?? config.appId,
      desktop: { ...desktop, entry: { ...entry, StartupWMClass: config.appId } },
    };
  }
  const png = [config.favicon, config.logo].find((file) => file?.toLowerCase().endsWith(".png"));
  if (png) {
    const extraResources = Array.isArray(upstream.extraResources) ? upstream.extraResources : [];
    result.extraResources = [...extraResources, { from: png, to: "host-branding/icon.png" }];
    if (result.win && typeof result.win === "object") result.win = { ...result.win, icon: png };
  }
  if (config.scheme) {
    for (const key of ["mac", "linux", "win"]) {
      if (!result[key] || typeof result[key] !== "object") continue;
      const current = result[key];
      const protocols =
        "protocols" in current && Array.isArray(current.protocols) ? current.protocols : [];
      const otherProtocols = protocols.filter(
        (entry: unknown) =>
          !(
            entry &&
            typeof entry === "object" &&
            "schemes" in entry &&
            Array.isArray(entry.schemes) &&
            entry.schemes.some((scheme: unknown) => scheme === "t3code" || scheme === "t3code-dev")
          ),
      );
      result[key] = {
        ...current,
        protocols: [
          {
            name: config.appName ?? "Application",
            schemes: [config.scheme, `${config.scheme}-dev`],
          },
          ...otherProtocols,
        ],
      };
    }
  }
  return result;
}

export function hostIconAssets<
  T extends { macIconPng: string; linuxIconPng: string; windowsIconIco: string },
>(upstream: T, config: HostBranding | null = loadHostBranding()): T {
  if (!config) return upstream;
  const png = [config.favicon, config.logo].find(
    (file) => file && NodePath.extname(file).toLowerCase() === ".png",
  );
  const ico = [config.favicon, config.logo].find(
    (file) => file && NodePath.extname(file).toLowerCase() === ".ico",
  );
  return {
    ...upstream,
    ...(png ? { macIconPng: png, linuxIconPng: png } : {}),
    ...(ico ? { windowsIconIco: ico } : {}),
  };
}
