import { expect, it } from "vite-plus/test";
import { backendEnvironment } from "./process.ts";

it("launches with only the extension bearer and strips inherited host credentials", () => {
  const environment = backendEnvironment(
    {
      PATH: "bin",
      T3CODE_DEV_AUTH_TOKEN: "host",
      T4_TOKEN: "host",
      T4_EXT_TOKEN: "old",
      ELECTRON_RUN_AS_NODE: "1",
    },
    {
      extensionId: "sample",
      url: "http://127.0.0.1:1234",
      token: "launch",
      instanceId: "instance",
      dataDir: "/data",
    },
  );
  expect(environment).toMatchObject({
    PATH: "bin",
    T4_EXT_ID: "sample",
    T4_EXT_PORT: "1234",
    T4_EXT_TOKEN: "launch",
    T4_EXT_INSTANCE: "instance",
    T4_EXT_DATA_DIR: "/data",
  });
  expect(environment).not.toHaveProperty("T3CODE_DEV_AUTH_TOKEN");
  expect(environment).not.toHaveProperty("T4_TOKEN");
  expect(environment).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
});
