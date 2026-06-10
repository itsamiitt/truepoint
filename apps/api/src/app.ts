// app.ts — compose the api: error handler + CORS (allow-listed app origins, credentials) + feature
// routers. The api is the only public HTTP surface (09); it trusts the access JWT and never issues one.

import { appOrigins } from "@leadwolf/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./features/auth/index.ts";
import { billingRoutes, creditsRoutes } from "./features/billing/index.ts";
import { importRoutes } from "./features/import/index.ts";
import { revealRoutes } from "./features/reveal/index.ts";
import { onError } from "./middleware/error.ts";
import { rateLimit } from "./middleware/rateLimit.ts";

export const app = new Hono();

app.onError(onError);
app.use("*", cors({ origin: [...appOrigins()], credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));
// Coarse per-caller throttle on the resource surface (IP-keyed here; per-subject once authn has set claims).
app.use("/api/*", rateLimit);
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/imports", importRoutes);
app.route("/api/v1/contacts", revealRoutes);
app.route("/api/v1/billing", billingRoutes);
app.route("/api/v1/credits", creditsRoutes);
