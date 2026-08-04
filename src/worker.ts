import { onRequest } from "../functions/api/[[path]]";

export interface Env {
  COWORKING_KV?: any;
  KV?: any;
  ASSETS?: { fetch: typeof fetch };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return onRequest({ request, env });
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
