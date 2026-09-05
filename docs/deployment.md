# Deploying OrbitWatch

Two services, deployed separately, because they are different kinds of thing: a
prerendered Next.js app that any CDN can serve, and a long-lived Node process that
holds database and cache connections.

| | where | why |
|---|---|---|
| Web | Vercel | Native Next.js. The response security headers in `next.config.ts` are compiled into the routes manifest and served by the platform; a static host cannot set them. |
| API | Fly.io, `syd` | Every request queries Supabase in `ap-southeast-2`. Same city, not the other side of the Pacific. |
| Database | Supabase (existing) | — |
| Cache | Upstash (existing) | — |
| Ingestion | GitHub Actions (`ingest.yml`) | Already scheduled; needs its secrets set. |

**Order matters.** The API goes first, because its public URL has to be compiled into
the web bundle — `NEXT_PUBLIC_*` values are inlined at build time, not read at run
time, so pointing the web app at the API is a rebuild, not a restart.

---

## 1. The API, on Fly.io

There is no Docker on the development machine, so builds run on Fly's remote builder.
That is what `--remote-only` is for; nothing needs installing beyond `flyctl`.

```bash
# once
iwr https://fly.io/install.ps1 -useb | iex     # PowerShell
fly auth login

# from the repo root, where fly.toml lives
fly launch --no-deploy --copy-config --name orbitwatch-api --region syd
```

`--copy-config` uses the committed `fly.toml` rather than generating a new one, and
`--no-deploy` stops it launching before the secrets exist. Say **no** to every offer to
provision a Postgres or Redis — both already exist and are configured below.

### Secrets

These are the only values that must not be in the repo. `fly secrets set` stores them
encrypted and injects them at run time; setting them triggers a deploy, hence
`--stage` to hold that until the image exists.

```bash
fly secrets set --stage `
  DATABASE_URL="<the pooled Supabase URI, port 6543>" `
  DATABASE_DIRECT_URL="<the direct Supabase URI, port 5432>" `
  UPSTASH_REDIS_REST_URL="<...>" `
  UPSTASH_REDIS_REST_TOKEN="<...>" `
  NASA_API_KEY="<...>" `
  LAUNCH_LIBRARY_API_KEY="<...>"
```

Copy them out of the root `.env.local`. Do not paste them into a file in the repo, and
do not echo them back into a terminal that is being recorded.

Everything else — `PORT`, `HOST`, `NODE_ENV`, `CORS_ORIGINS` — is in `fly.toml`,
because none of it is sensitive and a deployment that describes itself is worth more
than a marginally shorter config file.

```bash
fly deploy --remote-only
```

### Check it before moving on

```bash
curl https://orbitwatch-api.fly.dev/health
```

Look for `"database":{"configured":true,"healthy":true}`. If `configured` is false the
secret did not land; if `healthy` is false the connection string is the direct one
where it should be pooled, or Supabase is asleep.

---

## 2. The web app, on Vercel

Import the repository at vercel.com/new, then set:

| Setting | Value |
|---|---|
| Root Directory | `apps/web` |
| Include files outside root directory | **on** — the app depends on five workspace packages |
| Install Command | `pnpm install --frozen-lockfile` |
| Build Command | `cd ../.. && pnpm turbo run build --filter=@orbitwatch/web...` |
| Output Directory | `.next` (default) |

The `...` on the filter is load-bearing: it builds the workspace packages the app
imports, whose `main` fields point at `./dist`. Without it the build fails on a
missing `@orbitwatch/orbit-core`.

`pnpm build` in `apps/web` also runs a `prebuild` that copies 14 MB of Cesium engine
into `public/cesium`. That directory is gitignored and is not in the repository, so it
exists only because that script runs — verified that pnpm 11 does run `pre` scripts
automatically. If the globe 404s on `/cesium/Cesium.js`, that is what did not happen.

### Environment variable

Set for **Production**, then redeploy — it is compiled in, so an existing build will
not pick it up:

```
NEXT_PUBLIC_API_BASE_URL = https://orbitwatch-api.fly.dev
```

Note there is a gitignored `apps/web/.env.local` on the development machine that sets
this same variable for phone testing. Vercel never sees it, which is correct: it is a
local override, and the deployed value belongs in the platform.

---

## 3. The domain

`mohijitsingh.com` is served by GitHub Pages, with DNS at Wix
(`ns12.wixdns.net`, `ns13.wixdns.net`). Only a subdomain is being added; the apex is
untouched and the existing site keeps working.

In Vercel: **Settings → Domains → Add** `orbitwatch.mohijitsingh.com`.

Then in the Wix DNS editor for `mohijitsingh.com`, add the record Vercel asks for:

| Type | Host | Value |
|---|---|---|
| CNAME | `orbitwatch` | `cname.vercel-dns.com` |

Vercel issues the certificate once the record resolves, usually within minutes.

If the deployed origin ends up different from `https://orbitwatch.mohijitsingh.com`,
`CORS_ORIGINS` in `fly.toml` must change to match and the API be redeployed. The
allowlist is compared against the `Origin` header verbatim — a trailing slash or a
missing `https://` never matches, and the failure looks exactly like an API that is
down rather than one refusing the caller.

---

## 4. Ingestion

`ingest.yml` runs on a schedule and writes fresh elements to Supabase. It needs
`DATABASE_URL` as a repository secret:

```bash
gh secret set DATABASE_URL
```

Without it the deployment serves whatever was last ingested, ages it honestly, and
degrades the accuracy classification as the elements get older — which is the designed
behaviour, not a failure, but it is not a live product either.

---

## What deployment changes about the app

**The service worker starts working.** It requires a secure context, so on
`http://<lan-ip>:3100` it never registers at all and the offline behaviour built in M8
is dormant. On HTTPS it registers, the app becomes installable, and the offline banner
becomes reachable.

**The catalog is a ~7 MB response.** It is compressed in transit and cached by the
service worker after the first visit, but the first load on a phone over cellular is
the number worth watching. That, and frame rate with the full catalog, are the open
measurements in [ADR 0006](adr/0006-mobile-web-performance.md).
