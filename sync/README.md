# Dreamscroll sync (optional)

Shares the For You batch between the browser extension and the iPhone app. **You don't need this** to use Dreamscroll: without it, each device keeps its own batch.

This folder is a [Convex component](https://docs.convex.dev/components) plus a minimal Convex app that mounts it. The HTTP contract it implements is in [`docs/sync-api.md`](../docs/sync-api.md), if you'd rather write your own server.

## Option A: deploy this folder as its own Convex app

Needs [bun](https://bun.sh), Node 22+ (Convex's CLI runs on it) and a free [Convex](https://convex.dev) account.

```sh
cd sync
bun install
bunx convex login                      # 👤 opens a browser to sign in (once per machine)
bunx convex dev --once --configure=new # creates the project; choose your team when asked
bunx convex deploy --yes               # push to the production deployment
bunx convex env set --prod DREAMSCROLL_TOKEN "$(openssl rand -hex 32)"
bunx convex env set --prod DREAMSCROLL_TIMEZONE "America/New_York"   # optional, default UTC
bunx convex env get --prod DREAMSCROLL_TOKEN                         # the token to paste into the clients
```

Your server address is the **production** deployment's HTTP Actions URL, `https://<deployment-name>.convex.site`: in the Convex dashboard, switch to *Production*, then Settings › URL & Deploy Key. (`CONVEX_SITE_URL` in `.env.local` is the *dev* deployment, which has no token set, so it answers 401.)

## Option B: add it to a Convex app you already have

1. Copy `convex/dreamscroll/` into your app's `convex/` folder.
2. Mount it in `convex/convex.config.ts`:

   ```ts
   import { defineApp } from "convex/server";
   import dreamscroll from "./dreamscroll/convex.config";

   const app = defineApp();
   app.use(dreamscroll);
   export default app;
   ```

3. Register its routes in `convex/http.ts`:

   ```ts
   import { httpRouter } from "convex/server";
   import { components } from "./_generated/api";
   import { registerRoutes } from "./dreamscroll/routes";

   const http = httpRouter();
   registerRoutes(http, components.dreamscroll);
   export default http;
   ```

4. Set `DREAMSCROLL_TOKEN` (32+ characters) and optionally `DREAMSCROLL_TIMEZONE` in your deployment's environment, then deploy.

The component keeps its two tables to itself, so it can't collide with yours. `registerRoutes` takes options for a different path prefix, or to read the token and time zone from somewhere other than those environment variables (see [`routes.ts`](convex/dreamscroll/routes.ts)). The clients always call `/dreamscroll/…`, so keep the default prefix unless you proxy.

## Connect the clients

- **Extension:** main page › **Sync** › paste the address and token › **Save**. Chrome asks to allow access to that server; allow it.
- **iPhone:** in the extension, open **Sync › QR for iPhone** and scan it from the app's Settings › **Scan QR code** (or the Camera app). Or type the address and token into Settings.

## Develop

```sh
bun run test            # vitest + convex-test, runs the component in memory
bun run typecheck
bunx convex dev      # a dev deployment (CONVEX_AGENT_MODE=anonymous runs one locally without an account)
```
