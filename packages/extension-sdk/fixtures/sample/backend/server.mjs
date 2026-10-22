import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const { T4_EXT_ID, T4_EXT_PORT, T4_EXT_TOKEN, T4_EXT_DATA_DIR, T4_EXT_INSTANCE } = process.env;
await NodeFSP.writeFile(NodePath.join(T4_EXT_DATA_DIR, "backend.pid"), String(process.pid));
const streams = new Set();
const history = [];
let cursor = 0;
const frame = (n) => `id: ${n}\nevent: tick\ndata: ${JSON.stringify({ n })}\n\n`;
const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const server = NodeHttp.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${T4_EXT_TOKEN}`) {
    json(response, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/.t4/ready") {
    json(response, 200, {
      protocol: 1,
      extensionId: T4_EXT_ID,
      instanceId: T4_EXT_INSTANCE,
      dataDir: T4_EXT_DATA_DIR,
    });
  } else if (request.method === "GET" && url.pathname === "/hello") {
    json(response, 200, { message: "hello from sample" });
  } else if (request.method === "POST" && url.pathname === "/echo") {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      json(response, 200, {
        body: JSON.parse(Buffer.concat(chunks).toString()),
        scope: request.headers["x-t4-scope"],
      });
    } catch {
      json(response, 400, { error: "invalid_json" });
    }
  } else if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
    });
    response.write(": heartbeat\n\n");
    const since = Number(url.searchParams.get("cursor") ?? 0);
    for (const n of history) if (n > since) response.write(frame(n));
    streams.add(response);
    response.on("close", () => streams.delete(response));
  } else if (request.method === "POST" && url.pathname === "/tick") {
    history.push(++cursor);
    for (const stream of streams) stream.write(frame(cursor));
    json(response, 200, { n: cursor });
  } else if (request.method === "POST" && url.pathname === "/crash") {
    response.end();
    response.on("finish", () => process.exit(1));
  } else {
    json(response, 404, { error: "not_found" });
  }
});
server.listen(Number(T4_EXT_PORT), "127.0.0.1");
