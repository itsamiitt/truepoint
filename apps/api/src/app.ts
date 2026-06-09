// app.ts — compose the api: error handler + CORS (allow-listed app origins, credentials) + feature
// routers. The api is the only public HTTP surface (09); it trusts the access JWT and never issues one.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { appOrigins } from "@leadwolf/config";
import { onError } from "./middleware/error.ts";
import { authRoutes } from "./features/auth/index.ts";

export const app = new Hono();

app.onError(onError);
app.use("*", cors({ origin: [...appOrigins()], credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/api/v1/auth", authRoutes);
