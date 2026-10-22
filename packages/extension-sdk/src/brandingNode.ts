import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { parseHostBranding } from "./branding.ts";

export function loadHostBranding(
  root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url)),
) {
  const file = NodePath.resolve(root, "t4.branding.json");
  let contents: string;
  try {
    contents = NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const config = parseHostBranding(JSON.parse(contents));
  for (const key of ["logo", "favicon", "css"] as const) {
    if (config[key]) config[key] = NodePath.resolve(NodePath.dirname(file), config[key]);
  }
  return config;
}
