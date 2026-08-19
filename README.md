# WorkBoard OS

WorkBoard OS is a local-first work operating view for Google Tasks commitments, Obsidian context, and scoped Notion references.

## Run locally

```bash
npm install
npm run dev
```

Use `netlify dev` when testing the Netlify Function-backed Notion OAuth flow locally. Copy `.env.example` to `.env.local` and keep all secret values local.

## Verify the project

```bash
npm run lint
npm test
npm run build
```

## Push to Git

Create an empty repository on GitHub, copy its HTTPS or SSH URL, then run:

```bash
git remote add origin YOUR_REPOSITORY_URL
git push -u origin main
```

No credentials, vault contents, task exports, or sync logs belong in Git. `.env*`, `.netlify/`, `dist/`, backups, and sync logs are ignored.

## Link to Netlify

In Netlify, choose **Add new project → Import an existing project**, select this repository, and accept the settings from `netlify.toml`:

- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

Add these production environment variables in Netlify’s site settings, never in `netlify.toml`:

```text
NOTION_CLIENT_ID=
NOTION_CLIENT_SECRET=
NOTION_REDIRECT_URI=https://YOUR-SITE.netlify.app/api/notion/callback
```

Add the same `NOTION_REDIRECT_URI` to the Notion public connection, redeploy, then use **Settings → Notion references → Connect Notion**.

The Notion client secret is read only by the Netlify Function. The browser receives scoped, read-only search results; Notion content is not converted into work cards automatically.
