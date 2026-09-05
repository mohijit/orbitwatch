# Vercel project settings

Most of the build configuration lives in [`apps/web/vercel.json`](../apps/web/vercel.json)
rather than in the dashboard, because a setting in a file is reviewable, survives a
project being recreated, and does not depend on where a UI happens to put a field this
month. Only two things cannot go in that file.

## The two dashboard settings

| Setting | Value | Why it cannot be in the file |
|---|---|---|
| Root Directory | `apps/web` | Vercel reads it to find `vercel.json` in the first place. |
| `NEXT_PUBLIC_API_BASE_URL` | `https://orbitwatch-api.fly.dev` | It is environment configuration, and the whole point is that it differs per deployment. |

Set the environment variable for **All Environments**. Preview deployments hit the same
API as production here — there is no separate staging API — so scoping it to Production
only would leave every preview build silently unable to load the catalog.

It must be set **before** the build that uses it. `NEXT_PUBLIC_*` values are inlined
into the client bundle at build time, not read at run time, so adding the variable to an
existing project requires a redeploy before it takes effect.

## Fields the import screen asks about

**Output Directory** — leave it as the default. The build command changes directory to
the repo root to run turbo, but the output still lands in `apps/web/.next`, which is
what `.next` resolves to relative to the Root Directory.

**Install Command** — already in `vercel.json`. pnpm walks up to `pnpm-workspace.yaml`
and installs the whole workspace regardless of which member directory it is run from,
which is what the five workspace dependencies need.

**"Include files outside of the root directory"** — if this toggle is not on the screen,
that is fine. It existed because Vercel used to upload only the Root Directory; current
versions detect a pnpm workspace and include it. Do not go looking for it; the build
either finds the workspace or it does not, and the failure below says which.

## If the build fails

The signal to watch for is a missing workspace package — `Cannot find module
'@orbitwatch/orbit-core'` or a complaint that `pnpm-workspace.yaml` is absent. That
means Vercel uploaded only `apps/web` and the workspace is not visible.

The fallback is to build from the repo root instead, which cannot have that problem
because everything is in scope by definition:

| Setting | Value |
|---|---|
| Root Directory | *(blank — the repository root)* |
| Build Command | `pnpm turbo run build --filter=@orbitwatch/web...` |
| Output Directory | `apps/web/.next` |
| Install Command | `pnpm install --frozen-lockfile` |

With this arrangement `apps/web/vercel.json` is ignored, because Vercel looks for it in
the Root Directory. Those four values then have to be set in the dashboard.

The trailing `...` on the turbo filter is load-bearing in both arrangements: it builds
the workspace packages the app imports, whose `main` fields point at `./dist`. Without
it the build fails on a missing `@orbitwatch/orbit-core` — which looks identical to the
workspace-not-uploaded failure above, so check the filter before changing the layout.
