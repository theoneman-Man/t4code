// Shared URL helpers cannot depend on the host SDK. Builds embed its parsed config.
declare const __T4_HOST_BRANDING__: { scheme?: string } | null;

export function hostDesktopScheme(development: boolean) {
  const scheme =
    typeof __T4_HOST_BRANDING__ === "undefined" ? undefined : __T4_HOST_BRANDING__?.scheme;
  return scheme ? `${scheme}${development ? "-dev" : ""}` : development ? "t3code-dev" : "t3code";
}
