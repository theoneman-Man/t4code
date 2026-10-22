import { expect, it } from "vite-plus/test";
import { hostBuildConfig, hostIconAssets, hostProductName } from "./brandingBuild.ts";

it("preserves upstream artifact settings when no file exists", () => {
  const config = { appId: "com.t3tools.t3code", win: { icon: "icon.ico" } };
  expect(hostBuildConfig(config, null)).toBe(config);
  expect(hostProductName("T3 Code (Beta)", null)).toBe("T3 Code (Beta)");
  expect(hostProductName("T3 Code (Nightly)", null)).toBe("T3 Code (Nightly)");
});

it("applies product identity, protocols and packaged icons", () => {
  const host = {
    appName: "Sample",
    stageLabel: "Local",
    appId: "dev.example.sample",
    scheme: "sample",
    favicon: "/assets/icon.png",
  };
  const config = hostBuildConfig(
    {
      appId: "upstream",
      artifactName: "T3-Code-${version}-${arch}.${ext}",
      linux: {
        executableName: "t3code",
        desktop: { entry: { StartupWMClass: "t3code", Comment: "Existing" } },
      },
      win: { icon: "upstream.ico" },
      mac: {
        protocols: [
          { name: "T3 Code", schemes: ["t3code", "t3code-dev"] },
          { name: "Web", schemes: ["http", "https"] },
        ],
      },
      extraResources: ["existing"],
    },
    host,
  );
  expect(config.appId).toBe("dev.example.sample");
  expect(config.artifactName).toBe("Sample-${version}-${arch}.${ext}");
  expect(config.linux).toEqual({
    executableName: "sample",
    desktop: { entry: { StartupWMClass: host.appId, Comment: "Existing" } },
    protocols: [{ name: "Sample", schemes: ["sample", "sample-dev"] }],
  });
  expect(config.win).toEqual({
    icon: host.favicon,
    protocols: [{ name: "Sample", schemes: ["sample", "sample-dev"] }],
  });
  expect(config.mac).toEqual({
    protocols: [
      { name: "Sample", schemes: ["sample", "sample-dev"] },
      { name: "Web", schemes: ["http", "https"] },
    ],
  });
  expect(config.extraResources).toEqual([
    "existing",
    { from: host.favicon, to: "host-branding/icon.png" },
  ]);
  expect(hostProductName("T3 Code (Beta)", host)).toBe("Sample (Local)");
  expect(
    hostIconAssets(
      { macIconPng: "mac.png", linuxIconPng: "linux.png", windowsIconIco: "windows.ico" },
      host,
    ),
  ).toEqual({
    macIconPng: host.favicon,
    linuxIconPng: host.favicon,
    windowsIconIco: "windows.ico",
  });
});
