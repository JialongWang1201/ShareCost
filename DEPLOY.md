# Free hosting with GitHub Pages and Supabase

[简体中文](DEPLOY.zh-CN.md)

GitHub Pages serves the frontend. Supabase Free provides authentication and persistent shared data. No Render service, paid server, or custom domain is required. This project does not upgrade any subscription.

## 1. Initialize the database

Open the project’s [SQL Editor](https://supabase.com/dashboard/project/tzmgnrgeotahugglvces/sql/new), paste the complete contents of [`supabase/migrations/202610280001_sharecost.sql`](supabase/migrations/202610280001_sharecost.sql), and select **Run**.

Then run [`202610280002_avoid_profile_rewrites.sql`](supabase/migrations/202610280002_avoid_profile_rewrites.sql) to prevent unchanged profile data from being rewritten on reads. Existing installations only need this second migration. Use [`storage-report.sql`](supabase/maintenance/storage-report.sql) in the SQL Editor to inspect actual application, auth, and system storage before considering further compaction.

The initial migration creates a dedicated private schema and one authenticated RPC. Tables have RLS enabled and no browser grants. Every RPC checks the authenticated identity, ledger membership, and ownership before reading or changing data. All mutations of a ledger lock the same row to prevent double settlement. Repeating setup does not erase existing records. Keep `sharecost_private` out of the Data API’s exposed schemas.

## 2. Configure email confirmation redirects

Under [Authentication → URL Configuration](https://supabase.com/dashboard/project/tzmgnrgeotahugglvces/auth/url-configuration), set **Site URL** to:

```text
https://jialongwang1201.github.io/ShareCost/
```

Add that same URL to **Redirect URLs**. Keep email confirmation enabled. New users see a confirmation message, open the email link, and then log in.

## 3. Enable GitHub Pages

Sign in as `JialongWang1201`. Under [Settings → Pages](https://github.com/JialongWang1201/ShareCost/settings/pages), choose **GitHub Actions** as the publishing source. Run or rerun **Validate and deploy ShareCost** under [Actions](https://github.com/JialongWang1201/ShareCost/actions).

After the workflow succeeds, the expected site URL is:

```text
https://jialongwang1201.github.io/ShareCost/
```

The URL above is not proof of deployment; verify the workflow’s deployment result. Later pushes to `main` automatically test, build, and publish the frontend.

## Configuration and data

- `web/config.js` contains the public project URL and publishable browser key. No secret key, service-role key, database password, or paid service is needed by the frontend or workflow.
- Local `./start.sh` keeps using Python and SQLite with no Node runtime dependency. Local and cloud accounts/data are separate; no automatic migration takes place.
- Pages builds bundle the official Supabase browser SDK and upload only `dist/`, never the SQLite database.
- Cloud sessions are managed and refreshed by the official SDK in browser storage. Local sessions remain HttpOnly cookies. Application records are stored in the backend, not browser storage.
- A publishable key cannot create tables or administer the project. Use the SQL Editor for setup or explicitly authorize a Supabase management connection.

## Checks and preview

```sh
npm ci
npm run build
npm test
npm run check:cloud
python3 -m unittest discover -s tests -v
```

Cloud checks read public auth settings and verify anonymous ledger access is denied. They do not register users or create records. A missing RPC means step 1 has not been completed. `node tests/pages-browser-qa.mjs` additionally checks the real bundled SDK under `/ShareCost/` with intercepted auth requests; it creates no real users or emails. After setup, verify the live system using two real accounts sharing a ledger.

Preview the Pages build locally with `python3 -m http.server 8080 --directory dist`. Add its URL to Supabase Redirect URLs if testing email confirmation locally.

Keep the Supabase organization on **Free**. Free-tier quotas and inactivity pauses still apply; see [Supabase pricing](https://supabase.com/pricing).
