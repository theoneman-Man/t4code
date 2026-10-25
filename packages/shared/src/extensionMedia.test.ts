import { expect, it } from "vite-plus/test";
import { extensionMediaThumbnailPath, extensionMediaMimeType } from "./extensionMedia.ts";
it("replaces every existing width and preserves other query parameters", () => {
  expect(extensionMediaThumbnailPath("/image.jpg")).toBe("/image.jpg?w=512");
  const path = extensionMediaThumbnailPath("/image.jpg?v=a%2Fb&w=64&w=1600");
  const params = new URLSearchParams(path.split("?")[1]);
  expect(params.getAll("w")).toEqual(["512"]);
  expect(params.get("v")).toBe("a/b");
});
it("keeps the original when query encoding or added width exceeds the asset path limit", () => {
  for (const path of [
    "/" + "a".repeat(2047),
    "/image?v=" + "a".repeat(2039),
    "/image?v=" + "/".repeat(800),
  ])
    expect(extensionMediaThumbnailPath(path)).toBe(path);
  expect(extensionMediaThumbnailPath("/" + "a".repeat(2041))).toHaveLength(2048);
});

it("infers preview types from the path and leaves unknown image types unspecified", () => {
  expect(extensionMediaMimeType("/files/gate.jpg?v=one")).toBe("image/jpeg");
  expect(extensionMediaMimeType("/files/gate.webp?w=512")).toBe("image/webp");
  expect(extensionMediaMimeType("/files/image?v=one.png")).toBeUndefined();
});
