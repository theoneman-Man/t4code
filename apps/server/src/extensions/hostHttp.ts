import * as Layer from "effect/Layer";
import * as Http from "./http.ts";
import * as ThreadHttp from "./threadsHttp.ts";
import * as Host from "./ExtensionHost.ts";
import * as Threads from "./ExtensionThreads.ts";
import * as Operations from "./ThreadOperationsLive.ts";

export const layerWithHost = Layer.merge(
  Http.layer,
  ThreadHttp.layer.pipe(Layer.provide(Threads.layer.pipe(Layer.provide(Operations.layer)))),
).pipe(Layer.provide(Host.layer));
