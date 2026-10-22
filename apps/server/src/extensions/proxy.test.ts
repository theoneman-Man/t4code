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
