import { httpRouter } from "convex/server";
import { components } from "./_generated/api";
import { registerRoutes } from "./dreamscroll/routes";

const http = httpRouter();
registerRoutes(http, components.dreamscroll);
export default http;
