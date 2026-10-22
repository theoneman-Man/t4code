import { hostBranding } from "@t3tools/extension-sdk/branding";

export function hostDesktopIconPath(
  input: {
    isPackaged: boolean;
    resourcesPath: string;
    path: { join: (...segments: string[]) => string };
  },
  ext: string,
) {
  const png = [hostBranding?.favicon, hostBranding?.logo].find((file) =>
    file?.toLowerCase().endsWith(".png"),
  );
  if (!png || ext === "icns") return undefined;
  return input.isPackaged ? input.path.join(input.resourcesPath, "host-branding", "icon.png") : png;
}
