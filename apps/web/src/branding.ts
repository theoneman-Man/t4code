import { resolveHostAppBranding } from "@t3tools/extension-sdk/branding";
import type { DesktopAppBranding } from "@t3tools/contracts";
import { formatAppDisplayName } from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly" ? "Nightly" : HOSTED_APP_CHANNEL === "latest" ? "Latest" : null;
const upstreamBaseName = injectedDesktopAppBranding?.baseName ?? "T3 Code";
const upstreamStageLabel =
  injectedDesktopAppBranding?.stageLabel ??
  HOSTED_APP_CHANNEL_LABEL ??
  (import.meta.env.DEV ? "Dev" : "Beta");
const branding = resolveHostAppBranding({
  baseName: upstreamBaseName,
  stageLabel: upstreamStageLabel,
  displayName:
    injectedDesktopAppBranding?.displayName ??
    formatAppDisplayName({ baseName: upstreamBaseName, stageLabel: upstreamStageLabel }),
});
export const APP_BASE_NAME = branding.baseName;
export const APP_STAGE_LABEL = branding.stageLabel;
export const APP_DISPLAY_NAME = branding.displayName;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
export const DESKTOP_DOWNLOAD_URL = "https://t3.codes/download";
