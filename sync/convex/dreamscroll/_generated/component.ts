/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      apply: FunctionReference<
        "mutation",
        "internal",
        {
          ms?: number;
          now: number;
          op: "snapshot" | "spend";
          timeZone?: string;
          tweets?: string;
        },
        any,
        Name
      >;
      state: FunctionReference<
        "query",
        "internal",
        { now: number; timeZone?: string },
        any,
        Name
      >;
    };
  };
