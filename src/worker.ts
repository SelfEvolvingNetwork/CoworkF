import { CoworkingDO } from "./durable-object";
import { onRequest } from "../functions/api/[[path]]";

export { CoworkingDO };

export interface Env {
  COWORKING_DO?: DurableObjectNamespace;
  COWORKING_KV?: KVNamespace;
  KV?: KVNamespace;
  ASSETS?: { fetch: typeof fetch };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (env.COWORKING_DO) {
        const id = env.COWORKING_DO.idFromName("global_coworking_instance");
        const stub = env.COWORKING_DO.get(id);
        return stub.fetch(request);
      }
      return onRequest({ request, env });
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
