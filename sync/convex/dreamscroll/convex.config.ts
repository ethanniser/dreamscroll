import { defineComponent } from "convex/server";

// Dreamscroll sync, as a Convex component: its own tables and functions, mounted
// by an app with `app.use(dreamscroll)`. Routes come from ./routes (registerRoutes).
export default defineComponent("dreamscroll");
