# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Linux with `flock`, `curl`, and GNU `timeout`

## Sites Lifecycle

The Sites lifecycle CLI runs the locked dependency install before returning this checkout. Edit the source under `app/`, then checkpoint when a coherent milestone is ready to inspect or share. The remote Sites builder runs `npm run build` against the pushed commit. Do not repeat install or build as a normal pre-checkpoint step.

This starter does not use `wrangler.jsonc`.

`install:ci` is intentionally a single, non-retrying `npm ci`. It refuses a concurrent install for the same project, consumes a matching image-seeded npm cache with `--prefer-offline` while retaining registry fallback for a missing cache object, otherwise downloads and verifies the complete vinext tarball recorded in `package-lock.json`, limits npm to one socket, and terminates a stalled install. `build` applies a short timeout and then validates the Sites artifact. These helpers target Linux and use GNU `timeout`; they are not native macOS scripts.

Scripts that need writable project-scoped home, npm, XDG, and temporary paths use `scripts/sites-env.sh`. The `dev` and `start` scripts honor the caller's runtime environment and keep Wrangler logs inside the checkout. The generated `.sites-runtime/` directory is disposable and ignored by Git.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Diagnostic Commands

- `npm run install:ci`: perform the one bounded lockfile install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build and validate the deployable Sites artifact
- `npm run start`: start the built Vinext application
- `npm test`: build, validate, and verify the rendered development-preview metadata
- `npm run validate:artifact`: recheck an existing artifact's manifest and ESM `default.fetch` export
- `npm run db:generate`: generate Drizzle migrations after schema changes

Use build and validation commands for targeted diagnosis after a remote failure, not as part of the normal checkpoint path.

The timeout defaults can be overridden for a controlled canary with `SITES_INSTALL_TIMEOUT`, `SITES_INSTALL_KILL_AFTER`, `SITES_BUILD_TIMEOUT`, and `SITES_BUILD_KILL_AFTER`. A timeout fails the command; the helpers never retry an unchanged install or build.

## Montana Rental Cabins & Lookouts

The rental markers, Map Key entry, search results and rental links all come from `app/data/mt-cabins.json`, a static file generated by `scripts/build-mt-cabins.mjs`. It combines the USDA Forest Service Recreation Opportunities layer (names and coordinates), the Census state boundary (keeps only points inside Montana) and recreation.gov (every booking link is checked against a live, bookable facility before it is kept). Recreation.gov also supplies the BLM rentals (for example the Garnet Ghost Town winter cabins), which the Forest Service layer doesn't carry.

Each rental has a kind with its own map icon: cabin, fire lookout, guard station, or bunkhouse/house (bunkhouses, the Savenac cookhouse and cottages, homesteads). Icons are inline SVGs in `app/lib/map-icons.ts`.

Refresh it (cabins change slowly; a few times a year is plenty):

```bash
cd /path/to/openland-navigator
npm run data:cabins
```

Add `-- --report` to audit without writing the file. Cabins whose link cannot be verified get no booking button; the app shows the Forest Service rental instructions instead of a guessed link. The script refuses to overwrite the data file if the new result has far fewer cabins or links than the existing one (for example when Recreation.gov is unreachable); `--force` overrides.

## Mining Claim Icons

The map puts an icon on BLM mining claims (`app/lib/claim-markers.ts`), read live from the same BLM MLRS layers that draw the pink (active) and cyan (closed) claim areas. Queries are clipped to Montana.

- **Closed claims show at every zoom.** Zoomed out, every closed claim with a Montana case number (about 730 in BLM's map) loads once and clusters into counts. They show as cyan outlines because they haven't been checked yet. From zoom 11 in, each closed claim in view is compared with the active claims there: solid cyan means no active claim is mapped on that spot, grey means one is. Answers found while zoomed in are kept when you zoom back out.
- **Active claims show from zoom 11 in** as round pink icons (about 18,000 inside Montana).
- **Yellow ring:** a closed claim the nightly watch (below) saw close in the last 30 days.
- The picture shows the claim type: gold pan (placer), pickaxe (lode), gear (mill site), tunnel (tunnel site). BLM usually maps a claim to its survey square, so several claims often share one spot and show as a number.
- Tapping an icon runs the normal land check at that claim. If BLM can't be reached, a note says so; icons are never silently dropped.

## Nightly Montana Claim Watch

`.github/workflows/mt-claim-watch.yml` runs `scripts/mt-claim-watch.mjs` twice a day, at 09:23 and 21:23 UTC (free on GitHub's standard runners for public repos). The second run is a backup: GitHub starts scheduled runs late or drops them under load. It reads every BLM claim inside Montana's outline (open and closed), compares it with the previous night, and records what changed: claims that closed, new filings, claims BLM dropped from its open map, and closures BLM reversed. Results go to the `data` branch as `mt-claim-changes.json` (last 120 days) plus the full snapshot; each night replaces that branch with one commit, so it never builds up history.

The app reads the list from `https://raw.githubusercontent.com/cdalin1985/openland-navigator/data/mt-claim-changes.json` for the **Recently closed in Montana** panel and the yellow rings. A failed or incomplete BLM read stops the run without writing; a night where open claims drop by more than 25% is refused as a bad read (`--force` overrides). The first run only records a baseline.

Run it locally (writes to `claim-data/`, which git ignores):

```bash
cd /path/to/openland-navigator
npm run data:claim-watch
```

Start it by hand: Actions tab, **Montana claim watch**, **Run workflow**. GitHub turns scheduled workflows off after 60 days without repository activity; if the panel says the check has stopped, re-enable it on the same page.

## Quick-Jump Spots

The buttons in the map's top bar (`app/lib/hotspots.ts`) jump to creek-side points where the app's own land check said "likely open for casual panning" when they were last verified: BLM or National Forest land, no active claim within 25 m, no withdrawal or wilderness closure. Tapping one runs the live land check there, because claims change. Re-verify them (exits 1 if any spot has changed):

```bash
cd /path/to/openland-navigator
npm run check:hotspots
```

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
