# Setting up the LiB sales dashboard

One-off, about 20 minutes, the same as the Agent's Army dashboard. Everything is on
free plans (Cloudflare Pages, KV, Cloudflare Access for up to 50 users, GitHub Actions).

**It's safe at every step.** The site's files hold no figures: all data comes from
`/api/me`, which refuses to answer until the login is configured, and then only
answers verified @citysolution.co.uk / @latestinbeauty.com sign-ins.

## 1. Let GitHub publish to Cloudflare (two repo secrets)

Reuse the token from the Agent's Army dashboard if it has **Account → Cloudflare Pages
→ Edit**, or create one: dash.cloudflare.com → My Profile → API Tokens → Create Token
→ Custom Token, that one permission, your account.

github.com/CitySolution/lib-sales-dashboard → Settings → Secrets and variables →
Actions → New repository secret, twice:
- `CLOUDFLARE_API_TOKEN` = the token
- `CLOUDFLARE_ACCOUNT_ID` = the account ID (Workers & Pages, right-hand panel)

## 2. Create the storage (KV namespace)

dash.cloudflare.com → Storage & Databases → **KV** → Create → name
`lib-sales-dashboard-data`. Copy its **ID** into `wrangler.toml` (`id = "..."` under
`[[kv_namespaces]]`) and push. The deploy runs the tests, creates the Pages project and
publishes to `https://lib-sales-dashboard.pages.dev`.

## 3. Put the login in front of it (Cloudflare Access)

**3a. Previews:** Workers & Pages → `lib-sales-dashboard` → Settings → General →
**Preview access → Restrict previews**.

**3b. The main address:** one.dash.cloudflare.com (the same Zero Trust team as the
other dashboards) → Access → Applications → Add an application → **Self-hosted**:

- Name: `LiB Sales Dashboard`
- Public hostname: subdomain `lib-sales-dashboard`, domain `pages.dev`
- Policy: name `CitySolution and LiB`, action **Allow**, include **Emails ending in**:
  `@citysolution.co.uk` and `@latestinbeauty.com`
- Login method: **One-time PIN only** (so the email is always one the person proved they own)
- Save, open it again and copy the **Application Audience (AUD) Tag**

In `wrangler.toml` under `[vars]`, set:
- `TEAM_DOMAIN` = `https://<team-name>.cloudflareaccess.com` (the same value as in the
  Agent's Army dashboard's `wrangler.toml`)
- `POLICY_AUD` = the AUD tag

Push, and the site goes live behind the login. The server also checks the email domain
itself, so even a mistake in the Access policy can't let anyone else see data.

## 4. Check it

Open the address in a private window: you should get the Cloudflare sign-in. Sign in
with an admin email (`functions/_lib/users.json`) and you'll see the Uploads tab's
**Add new TikTok figures** box.

## Admins

Admins can upload and edit costs; everyone else on the two domains can view. The list
is `functions/_lib/users.json` - add an email and push.

## Updating the figures (weekly)

1. TikTok Seller Center → **Finance → Statements → Export**. Pick a date range that
   covers everything since the last upload - overlapping is fine - and download the .xlsx.
2. Dashboard → **Uploads** → choose the file(s). The summary shows how many statements
   are new and how many are already loaded (skipped).
3. **Add to dashboard.**

For the first load, upload every export since 1 January 2026 (several files at once is
fine). Then enter each box's costs on the **Costs** tab. Boxes without costs are
flagged on the Summary.

**Rollback:** the version before each upload is kept as `data_prev` in the
`lib-sales-dashboard-data` KV namespace.
