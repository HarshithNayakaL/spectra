# Deployment

SPECTRA has two deployment units because public audits require bounded outbound HTTP, a native Rust process, long-running Gemini calls, and durable audit storage.

## Supported production shape

1. Build `apps/web` as static assets and deploy them to Vercel or another CDN.
2. Deploy `apps/api` with the release Rust crawler in a container service such as Cloud Run, Fly.io, Railway, or ECS.
3. Set `VITE_API_URL` during the web build to the public API origin.
4. Set `GEMINI_API_KEY`, `GEMINI_MODEL`, `SPECTRA_WEB_ORIGINS`, `SPECTRA_CRAWLER_BIN`, and an absolute durable `SPECTRA_DATA_DIR` on the API service. `SPECTRA_WEB_ORIGINS` must contain the deployed web origin; requests from other browser origins are rejected.
5. Put the crawler container behind an egress firewall that also blocks private, link-local, and metadata networks. Application SSRF validation is one layer, not the only layer.

Vercel serverless functions are not the API target for V1: they cannot reliably ship/spawn the native crawler with durable local audit files, and a full grounded audit can exceed short request limits. The web application remains Vercel-compatible; the API boundary is explicit rather than silently substituting a different crawler.

## Production checks

```bash
npm ci
npm run check
cargo test --manifest-path services/crawler/Cargo.toml
cargo build --release --manifest-path services/crawler/Cargo.toml
```

`NODE_ENV=production` fails fast when `GEMINI_API_KEY` is absent. `/api/health` reports the configured model and whether Gemini is configured, without exposing the key.

The filesystem audit store is durable only when `SPECTRA_DATA_DIR` points to a persistent volume. It is intentionally isolated behind `saveAudit`/`getAudit`; replacing it with PostgreSQL does not change pipeline or report contracts.
