# Hesty Status

Status page and email alerts for Hesty and the third parties it depends on.

- **Runs outside Hesty's servers.** GitHub Actions checks every service every hour, so the page and the alerts keep working when Hesty itself is down.
- **Page:** current status, 90-day uptime bars (30 on phones) and incidents from the last 14 days. It's published on GitHub Pages.
- **Alerts:** an email when a service goes down, and another when it's back up, with how long it was down. Each outage sends one email, not one per check.

## What is checked

Defined in [`config/services.json`](config/services.json).

| Group | Service | How |
|---|---|---|
| Hesty | Website | `https://hesty.io` loads the app |
| Hesty | API | `GET /api/v1/auth/siwe/nonce` returns a nonce |
| Hesty | Database | `GET /api/v1/health`: the backend pings MongoDB (200, or 503 if it can't reach it) |
| Hesty | Files & translations | A translation file on the DigitalOcean Spaces CDN |
| Hesty | Email delivery | Logs in to the SMTP server Hesty sends emails through |
| Blockchain | Base RPC | `mainnet.base.org` returns the latest block, and that block is less than 60 s old |
| Blockchain | Base network | status.base.org: block production, public RPC |
| Third parties | Reown | status.reown.com: AppKit, Relay, Blockchain API, Verify API |
| Third parties | Monerium | `api.monerium.app` answers |
| Third parties | Onfido | status.onfido.com: Europe API, document and face checks, webhooks, JS SDK |
| Third parties | Coinbase Developer Platform | status.coinbase.com: CDP Wallets, Onchain Tools |
| Third parties | DigitalOcean | status.digitalocean.com: Droplets, Spaces, Spaces CDN and Networking in FRA1 |

**Status meanings:**
- **Down:** the check failed 3 times in a row, about 10 seconds apart, or a provider reports a major outage. **Sends an email.**
- **Degraded:** a slow response (over 5 s), a stale block, or a provider reporting partial issues or maintenance. Shown in yellow, no email.
- **Unknown:** the check couldn't run, e.g. a provider's status page is unreachable or SMTP isn't configured. No email.

## Setup

1. **Deploy the backend health endpoint.** `hesty-backend2` gets `GET /api/v1/health` from `src/core/health/`. Until that's deployed, "Database" shows as down.
2. **Create a GitHub repo** (e.g. `hesty-status`) and push this folder to `main`.
   - GitHub Pages is free for public repos.
   - A private repo needs a paid GitHub plan for Pages.
   - Nothing secret is in the repo: credentials go into GitHub secrets, and the page only shows statuses.
3. **Turn on Pages:** Settings → Pages → Source: **GitHub Actions**.
4. **Add secrets:** Settings → Secrets and variables → Actions → *New repository secret*.

   | Secret | Value |
   |---|---|
   | `ALERT_TO` | Who gets alerts, comma-separated, e.g. `boss@hesty.io,pedro@hesty.io` |
   | `SMTP_HOST` | The backend's `EMAIL_HOST` |
   | `SMTP_PORT` | `587` (the port the backend uses) |
   | `SMTP_USER` | The backend's `EMAIL_USER` |
   | `SMTP_PASS` | The backend's `EMAIL_PASSWORD` |
   | `ALERT_FROM` | Optional sender, e.g. `Hesty Status <status@hesty.io>`. Defaults to the SMTP user. |

   **Recommended:** send alerts through a different email provider than the one being monitored. Then a problem with Hesty's email server can still be reported. Set `ALERT_SMTP_HOST`, `ALERT_SMTP_PORT`, `ALERT_SMTP_USER` and `ALERT_SMTP_PASS`, e.g. a Gmail app password or a Resend or Brevo account. Without them, alerts use the `SMTP_*` settings.

   **Backup channel:** if an alert email fails to send, the workflow run fails. GitHub then emails the repo's admins its usual "run failed" notice.
5. **Run it once:** Actions → *Status checks* → *Run workflow*. After that it runs every hour. The page URL appears on the run, e.g. `https://<org>.github.io/hesty-status/`.

### Optional: status.hesty.io

1. Add a `docs/CNAME` file containing `status.hesty.io`.
2. Point a DNS `CNAME` record for `status` to `<org>.github.io`.
3. Set the custom domain in Settings → Pages.
4. Add a repository **variable** (not a secret) `STATUS_PAGE_URL=https://status.hesty.io/`, so alert emails link to it.

## Changing what is checked

Edit `config/services.json`; the next run picks it up. Check types:

- **`http`**:
  - `url`;
  - optional `contains` (text the response must include);
  - `expectStatus` (a number or list; defaults to any 2xx/3xx);
  - `slowMs` (default 5000);
  - `timeoutMs` (default 10000).
- **`jsonrpc`**: an EVM RPC `url`, plus `maxBlockAgeSec` (default 60).
- **`statuspage`**: a provider's Atlassian Statuspage `page` URL, plus `components`.
  - Use names exactly as shown on the page, with `"Group > Component"` for grouped ones.
  - To list them: `curl -s <page>/api/v2/components.json`.
  - Without `components`, the page's overall status is used.
- **`smtp`**: uses the `SMTP_*` secrets.

Per service:
- `"alert": false` stops emails for it.
- `"alertOnDegraded": true` also emails when it's degraded.

## Local use

```sh
npm install
npm run check     # runs every check once and writes docs/data/status.json
npm run preview   # serves the page at http://localhost:3000
```

Without SMTP env vars, alerts are only printed.

## How it works

- `scripts/check.mjs` runs the checks. It records each day's results (`checks`, `down`, `degraded`) for 90 days, opens and closes incidents, and sends the emails.
- Results are stored in `status.json` on the `status-data` branch. That branch is a single commit, replaced on every run, so `main`'s history stays clean.
- The workflow then publishes `docs/` together with that file to GitHub Pages.
- The page reloads the data every minute. If no check has run for 3 check intervals (3 hours), it shows a "monitoring delayed" warning.

**Limitations:**
- **Late runs:** GitHub can start scheduled runs a few minutes late when it's busy, so an alert can take up to about an hour (sometimes a bit more) to arrive. Outages shorter than an hour that start and end between two checks are not seen.
- **Scheduled runs can be paused:** in public repos, GitHub turns off scheduled workflows after 60 days with no activity in the repo. It emails a warning first, and one click on the Actions tab turns them back on. Pushing any small commit now and then avoids it.
