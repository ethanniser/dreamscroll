import { httpActionGeneric, type FunctionReference, type HttpRouter } from "convex/server";
import { snapshotJson, type PublicState } from "./rules";

// Registers the Dreamscroll sync API (docs/sync-api.md) on an app's router:
//
//   // convex/http.ts
//   import { httpRouter } from "convex/server";
//   import { components } from "./_generated/api";
//   import { registerRoutes } from "./dreamscroll/routes";
//   const http = httpRouter();
//   registerRoutes(http, components.dreamscroll);
//   export default http;
//
// Runs in the app (not the component), so it reads the app's environment:
//   DREAMSCROLL_TOKEN     required, 32+ characters: clients send `Authorization: Bearer <token>`
//   DREAMSCROLL_TIMEZONE  optional IANA zone for the budget day (default UTC)

type Args = { now: number; timeZone?: string };
export type DreamscrollComponent = {
  lib: {
    state: FunctionReference<"query", "internal", Args, PublicState>;
    apply: FunctionReference<"mutation", "internal", Args & { op: "snapshot" | "spend"; tweets?: string; ms?: number }, PublicState>;
  };
};

export type RouteOptions = {
  /** Defaults to "/dreamscroll" (what the clients call). */
  pathPrefix?: string;
  /** Defaults to process.env.DREAMSCROLL_TOKEN. */
  token?: () => string | undefined;
  /** Defaults to process.env.DREAMSCROLL_TIMEZONE. */
  timeZone?: () => string | undefined;
};

function authorized(req: Request, expected: string | undefined): boolean {
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || expected.length < 32 || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function registerRoutes(http: HttpRouter, component: DreamscrollComponent, options: RouteOptions = {}) {
  const prefix = (options.pathPrefix ?? "/dreamscroll").replace(/\/+$/, "");
  const token = options.token ?? (() => process.env.DREAMSCROLL_TOKEN);
  const timeZone = options.timeZone ?? (() => process.env.DREAMSCROLL_TIMEZONE);

  http.route({
    path: `${prefix}/state`,
    method: "GET",
    handler: httpActionGeneric(async (ctx, req) => {
      if (!authorized(req, token())) return json({ error: "unauthorized" }, 401);
      return json(await ctx.runQuery(component.lib.state, { now: Date.now(), timeZone: timeZone() }));
    }),
  });

  for (const op of ["snapshot", "spend"] as const) {
    http.route({
      path: `${prefix}/${op}`,
      method: "POST",
      handler: httpActionGeneric(async (ctx, req) => {
        if (!authorized(req, token())) return json({ error: "unauthorized" }, 401);
        let body: Record<string, unknown> = {};
        try {
          const parsed: unknown = await req.json();
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        } catch {
          return json({ error: "invalid json" }, 400);
        }
        // A snapshot that can't be stored is refused outright (never truncated).
        const tweets = op === "snapshot" ? snapshotJson(body.tweets) : undefined;
        if (op === "snapshot" && !tweets) return json({ error: "invalid or oversized snapshot" }, 422);
        return json(await ctx.runMutation(component.lib.apply, {
          op,
          now: Date.now(),
          timeZone: timeZone(),
          tweets: tweets ?? undefined,
          ms: typeof body.ms === "number" ? body.ms : undefined,
        }));
      }),
    });
  }
}
