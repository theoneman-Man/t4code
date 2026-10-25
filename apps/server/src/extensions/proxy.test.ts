import { expect, it } from "vite-plus/test";
import type { ResolvedExtension } from "@t3tools/extension-sdk/node";
import { parseProxyTarget, requestHeaders, responseHeaders, routeScope } from "./proxy.ts";

const extension: ResolvedExtension = {
  root: "/sample",
  manifest: {
    id: "sample",
    sdk: 1,
    routes: [
      { method: "GET", path: "/hello", scope: "read" },
      { method: "POST", path: "/echo", scope: "operate" },
    ],
  },
};

it("maps only declared routes to their environment scopes", () => {
  expect(routeScope([extension], "GET", "/ext/sample/hello?name=a")).toEqual({
    id: "sample",
    path: "/hello",
    search: "?name=a",
    scope: "read",
  });
  expect(routeScope([extension], "POST", "/ext/sample/echo")?.scope).toBe("operate");
  expect(routeScope([extension], "GET", "/ext/sample/other")).toBeUndefined();
  expect(routeScope([extension], "GET", "/ext/unknown/hello")).toBeUndefined();
  expect(routeScope([], "GET", "/ext/sample/hello")).toBeUndefined();
});

it("rejects traversal before URL normalization, including repeated encoding", () => {
  for (const path of [
    "../hello",
    "%2e%2e/hello",
    "%252e%252e/hello",
    "a%2f..%2fhello",
    "a\\..\\hello",
    "%zz",
    "%00",
  ]) {
    expect(parseProxyTarget(`/ext/sample/${path}`)).toBeNull();
  }
  expect(parseProxyTarget("/ext/sample/hello?value=../ok")).toEqual({
    id: "sample",
    path: "/hello",
    search: "?value=../ok",
  });
});

it("replaces credentials and strips hop headers in both directions", () => {
  expect(
    requestHeaders(
      {
        authorization: "client",
        cookie: "session=value",
        dpop: "proof",
        "x-t3-session": "host",
        "x-t4-scope": "operate",
        connection: "x-private",
        "x-private": "secret",
        host: "host",
        "content-type": "application/json",
        "accept-encoding": "gzip",
      },
      "backend",
      "read",
    ),
  ).toEqual({
    "content-type": "application/json",
    authorization: "Bearer backend",
    "x-t4-scope": "read",
  });
  expect(
    responseHeaders({
      "set-cookie": "secret",
      authorization: "private",
      connection: "x-private",
      "x-private": "secret",
      "content-type": "text/event-stream",
    }),
  ).toEqual({
    "content-type": "text/event-stream",
    "cache-control": "no-store, no-transform",
  });
});

it("preserves caching metadata and unencoded lengths", () => {
  const headers = {
    "cache-control": "private, max-age=31536000, immutable",
    etag: '"image-v1"',
    "last-modified": "Sun, 25 Oct 2026 08:00:00 GMT",
    expires: "Mon, 25 Oct 2027 08:00:00 GMT",
    vary: "Accept",
    "content-length": "512",
  };
  expect(responseHeaders(headers)).toEqual(headers);
  expect(responseHeaders({ ...headers, "content-encoding": "gzip" })).toEqual(
    Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "content-length")),
  );
  expect(
    requestHeaders(
      { "if-none-match": headers.etag, "if-modified-since": headers["last-modified"] },
      "token",
      "read",
    ),
  ).toMatchObject({
    "if-none-match": headers.etag,
    "if-modified-since": headers["last-modified"],
  });
});

it("keeps authenticated responses private and removes shared-cache lifetimes", () => {
  expect(
    responseHeaders({ "cache-control": "public, max-age=42, s-maxage=900, no-transform" })[
      "cache-control"
    ],
  ).toBe("private, max-age=42, no-transform");
  expect(
    responseHeaders({ "cache-control": "PUBLIC, S-MAXAGE = 90, immutable" })["cache-control"],
  ).toBe("private, immutable");
  expect(responseHeaders({})["cache-control"]).toBe("no-store, no-transform");
});
