import type { ReactNode } from "react";
import { hostBranding } from "@t3tools/extension-sdk/branding";

export function hostSidebarBrand(upstream: ReactNode) {
  if (!hostBranding?.appName && !hostBranding?.logo) return upstream;
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium">
      {hostBranding.logo ? (
        <span
          aria-hidden="true"
          className="size-5 bg-contain bg-center bg-no-repeat [background-image:var(--host-logo)]"
        />
      ) : null}
      {hostBranding.appName ?? "T3 Code"}
    </span>
  );
}
