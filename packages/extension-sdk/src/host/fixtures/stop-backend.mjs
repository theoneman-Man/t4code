import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const { T4_EXT_PORT, T4_EXT_TOKEN, T4_EXT_ID, T4_EXT_INSTANCE, T4_EXT_DATA_DIR } = process.env;
const mode = process.argv[2];
await NodeFSP.writeFile(NodePath.join(T4_EXT_DATA_DIR, "backend.pid"), String(process.pid));
process.on("exit", (code) =>
  NodeFS.writeFileSync(NodePath.join(T4_EXT_DATA_DIR, "exit-code"), String(code)),
);
const server = NodeHttp.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${T4_EXT_TOKEN}`) {
    response.writeHead(401).end();
  } else if (request.url === "/.t4/ready") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        protocol: 1,
        extensionId: T4_EXT_ID,
        instanceId: T4_EXT_INSTANCE,
        dataDir: T4_EXT_DATA_DIR,
      }),
    );
  } else if (request.method === "POST" && request.url === "/.t4/shutdown") {
    await NodeFSP.writeFile(NodePath.join(T4_EXT_DATA_DIR, "shutdown-requested"), request.method);
    if (mode === "unsupported") {
      response.writeHead(404).end();
      return;
    }
    if (mode === "disconnect") {
      request.socket.destroy();
      return;
    }
    if (mode === "stall-response") return;
    response.writeHead(202).end();
    if (mode === "stall-exit") return;
    server.close(async () => {
      await NodeFSP.writeFile(NodePath.join(T4_EXT_DATA_DIR, "finalized"), "stopped");
    });
    server.closeIdleConnections();
  } else {
    response.writeHead(404).end();
  }
});
server.listen(Number(T4_EXT_PORT), "127.0.0.1");
