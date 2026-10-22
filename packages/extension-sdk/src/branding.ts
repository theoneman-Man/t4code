export interface HostBranding {
  appName?: string;
  stageLabel?: string;
  appId?: string;
  scheme?: string;
  homeDirName?: string;
  logo?: string;
  favicon?: string;
  tokens?: Record<string, string>;
  css?: string;
}

declare const __T4_HOST_BRANDING__: HostBranding | null;

export const hostBranding =
  typeof __T4_HOST_BRANDING__ === "undefined" ? null : __T4_HOST_BRANDING__;

export function parseHostBranding(value: unknown): HostBranding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Host branding must be an object.");
  }
  const result: HostBranding = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "tokens") {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Host branding tokens must be an object.");
      }
      result.tokens = {};
      for (const [name, token] of Object.entries(entry)) {
        if (
          !/^--[a-zA-Z0-9_-]+$/.test(name) ||
          typeof token !== "string" ||
          /[;{}<>]/.test(token)
        ) {
          throw new Error("Invalid host branding token.");
        }
        result.tokens[name] = token;
      }
    } else if (
      key === "appName" ||
      key === "stageLabel" ||
      key === "appId" ||
      key === "scheme" ||
      key === "homeDirName" ||
      key === "logo" ||
      key === "favicon" ||
      key === "css"
    ) {
      if (typeof entry !== "string" || !entry.trim() || /[\r\n\0]/.test(entry)) {
        throw new Error(`Invalid host branding ${key}.`);
      }
      result[key] = entry.trim();
    } else {
      throw new Error(`Unknown host branding field: ${key}.`);
    }
  }
  if (result.scheme && !/^[a-z][a-z0-9+.-]*$/.test(result.scheme))
    throw new Error("Invalid host branding scheme.");
  if (result.appId && !/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9_-]+)+$/.test(result.appId))
    throw new Error("Invalid host branding appId.");
  if (
    result.homeDirName &&
    (!/^\.?[a-zA-Z0-9_-]+$/.test(result.homeDirName) || result.homeDirName === ".")
  )
    throw new Error("Invalid host branding homeDirName.");
  return result;
}

export function resolveHostAppBranding<
  T extends { baseName: string; stageLabel: string; displayName: string },
>(upstream: T, config = hostBranding) {
  if (!config || (!config.appName && !config.stageLabel)) return upstream;
  const baseName = config.appName ?? upstream.baseName;
  const stageLabel = config.stageLabel ?? upstream.stageLabel;
  return { ...upstream, baseName, stageLabel, displayName: `${baseName} (${stageLabel})` };
}

export function hostScheme(upstream: string, development: boolean, config = hostBranding) {
  return config?.scheme ? `${config.scheme}${development ? "-dev" : ""}` : upstream;
}

export function hostIdentity(upstream: string, development: boolean, config = hostBranding) {
  return config?.appId ? `${config.appId}${development ? ".dev" : ""}` : upstream;
}

export function hostHomeDirName(config = hostBranding) {
  return config?.homeDirName ?? ".t3";
}
