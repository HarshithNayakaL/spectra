import { serve } from "@hono/node-server";
import { app } from "./app";

serve(
  { fetch: app.fetch, port: Number(process.env.SPECTRA_API_PORT || 8787) },
  (info) => console.log(`SPECTRA API listening on ${info.port}`),
);
