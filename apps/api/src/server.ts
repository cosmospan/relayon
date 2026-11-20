import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.API_PORT ?? 8787);
serve({ fetch: createApp().fetch, port });
console.log(JSON.stringify({ msg: "relayon api listening", port }));
