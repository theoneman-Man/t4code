import { matchExtensionRoute, type ExtensionRouteScope } from "@t3tools/extension-sdk/manifest";
import type { ResolvedExtension } from "@t3tools/extension-sdk/node";

const hasControlCharacter = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function parseProxyTarget(rawUrl: string) {
  const query = rawUrl.indexOf("?");
  const rawPath = query < 0 ? rawUrl : rawUrl.slice(0, query);
  const search = query < 0 ? "" : rawUrl.slice(query);
  let decoded = rawPath;
  // Decode nested escapes too, so a downstream router cannot reinterpret a safe-looking path.
  for (let depth = 0; depth < 8; depth++) {
    if (
      decoded.includes("\\") ||
      hasControlCharacter(decoded) ||
      decoded.split("/").some((part) => part === "." || part === "..")
    )
      return null;
    if (!decoded.includes("%")) break;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  if (
    decoded.includes("%") ||
    decoded.includes("\\") ||
    decoded.split("/").some((part) => part === "." || part === "..") ||
    hasControlCharacter(decoded) ||
    decoded.includes("?") ||
    decoded.includes("#")
  )
    return null;
  const match = /^\/ext\/([a-z][a-z0-9-]{0,39})(\/.*)?$/.exec(decoded);
  if (!match?.[1]) return null;
  // Preserve escaped path bytes for the backend, after checking their decoded meaning.
  const prefix = `/ext/${match[1]}`;
  if (!rawPath.startsWith(prefix)) return null;
  return { id: match[1], path: rawPath.slice(prefix.length) || "/", search };
}

export function routeScope(
  extensions: readonly ResolvedExtension[],
  method: string,
  rawUrl: string,
) {
  const target = parseProxyTarget(rawUrl);
  if (!target) return undefined;
  const extension = extensions.find((item) => item.manifest.id === target.id);
  const route =
    extension &&
    matchExtensionRoute(extension.manifest.routes, method, decodeURIComponent(target.path));
  return route ? { ...target, scope: route.scope } : undefined;
}

const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const clientHeaders = new Set([
  "authorization",
  "cookie",
  "dpop",
  "host",
  "content-length",
  "accept-encoding",
  "origin",
  "referer",
  "forwarded",
]);

function cleanHeaders(headers: Readonly<Record<string, string | undefined>>, request: boolean) {
  const dropped = new Set(hopHeaders);
  for (const name of (headers.connection ?? "").split(",")) dropped.add(name.trim().toLowerCase());
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (
      value === undefined ||
      dropped.has(name) ||
      name === "set-cookie" ||
      name === "authorization" ||
      name === "cookie" ||
      name === "dpop"
    )
      continue;
    if (request && (clientHeaders.has(name) || /^x-(?:t3|t4|forwarded-|.*session)/.test(name)))
      continue;
    result[name] = value;
  }
  return result;
}

export function requestHeaders(
  headers: Readonly<Record<string, string | undefined>>,
  token: string,
  scope: ExtensionRouteScope,
) {
  return { ...cleanHeaders(headers, true), authorization: `Bearer ${token}`, "x-t4-scope": scope };
}

export function responseHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result = cleanHeaders(headers, false);
  // Fetch decodes upstream compression; its original length/encoding no longer describe the stream.
  if (result["content-encoding"]) delete result["content-length"];
  delete result["content-encoding"];
  if (result["cache-control"] !== undefined) {
    result["cache-control"] = result["cache-control"]
      .split(",")
      .map((directive) => directive.trim())
      .filter((directive) => !/^s-maxage\s*=/i.test(directive))
      .map((directive) => (/^public$/i.test(directive) ? "private" : directive))
      .join(", ");
  }
  return { "cache-control": "no-store, no-transform", ...result };
}
