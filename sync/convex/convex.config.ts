import { defineApp } from "convex/server";
import dreamscroll from "./dreamscroll/convex.config";

// A complete sync server: just the Dreamscroll component. To add sync to an app you
// already have, copy convex/dreamscroll/ into it and add these two lines to its config.
const app = defineApp();
app.use(dreamscroll);
export default app;
