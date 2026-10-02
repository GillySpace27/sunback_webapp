# My Heliograph (webapp)

The store at myheliograph.com: pick a date, see the Sun as NASA's Solar
Dynamics Observatory recorded it, and order it printed on a product.
Internal names stay solar-archive (code, Shopify handle) and
myheliograph-api (Fly app). On Gilly's Mac this repository sits inside the
sunback checkout at ~/vscode/sunback/webapp, but it is its own git
repository.

Agents: read CLAUDE.md first. Humans: this page, then DEPLOY.md.

## How it fits together

    Browser
      -> Cloudflare Worker myheliograph-router (infra/worker/src/index.js)
           static assets: the film at / and /experience/ (web3d build),
           the store at /store/ (api/index.html and its modules)
           everything else proxied to the origin; images edge-cached
      -> Fly app myheliograph-api (api/main.py, FastAPI)
           one machine, one uvicorn worker, volume "data" at /var/data,
           scales to zero
           in: Helioviewer, VSO, JSOC, HEK; out: previews and print masters
           Printify for products, Shopify Storefront for checkout links
      -> Fly app myheliograph-render (render-service/, private)
           Playwright renders of web3d plates, used as a fallback

Dev tier: dev.myheliograph.com, Fly app myheliograph-api-dev, Worker
myheliograph-router-dev. Dev has no Shopify credentials by design, so no
checkout can complete there.

## Run locally

    ./run_server                          # origin on http://127.0.0.1:8000
    cd web3d && npm ci && npm run dev     # film dev server

run_server sources .env when present. Never print or commit .env.

## Check

    ./infra/scripts/check.sh              # every self-check
    ./infra/scripts/check.sh --list       # the names of the checks

The self-checks live in api/scripts/ (see api/scripts/README.md).
Recorded, scrubbed responses for offline work live in api/scripts/fixtures/.

## Deploy

DEPLOY.md is the procedure. The deploy-myheliograph skill
(.claude/skills/deploy-myheliograph/) drives it and its status.py tracks
it. Every deploy, rollback and secret change needs Gilly's explicit yes
for that one action.

## Must not

- Delete nothing. Retire a file with git mv into attic/ and a row in
  attic/README.md; retire a branch with a local archive tag.
- One Fly machine and one uvicorn worker. Scale in fly.toml, never only
  with fly scale.
- Never deploy from an unmerged branch. Promote the reviewed image
  digest; never rebuild for prod.
- infra/worker/build-public.sh fails closed without the web3d build and
  injects the dev noindex tag last. Never blind-merge it.
- Never serve api/ as static or copy it wholesale into the Worker's
  assets: .py source must not be served. New store modules need a
  whitelist entry (see CLAUDE.md).
- Mount order: /asset/default and /asset/preview before /asset.
- The dev tier never gets Shopify credentials.
- Secrets never appear in a terminal, log or commit.
- NASA/SDO attribution stays visible on every page, phones included.
- Dates offered to buyers are clamped to /api/data_frontier.
- Buyer-facing words are Original and Enhanced.
- The design hash excludes overlay text (personal data); feedback files
  are never committed.
- GA4 only after consent; Sentry for crash reports only.
- RHEF output is a visualization, not a calibrated radiance.
- heliograph.com is not ours; the store is myheliograph.com.

## Branches

BRANCHES.md lists every unmerged branch, Gilly's land-or-park decisions,
the landing order and the FREEZE list of files closed to structural moves.

## Licence

None yet. Choosing one is Gilly's decision (open question Q6 in the
modernization plan).
