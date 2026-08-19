# Development notes

## Dry-run workflow

1. Start the app with `npm run dev`.
2. Exercise movement, completion, Today role selection, and capture using the seeded synthetic data.
3. Confirm the UI reports local changes only. No source task or note is changed by the browser foundation.
4. Provider work should add a read-only preview and stable `(source_provider, source_id)` mapping before any write-back action.

## Current known limitations

- Data is stored in `localStorage` for the browser foundation.
- Google Tasks has a synthetic, read-only dry-run preview plus a browser OAuth path configured from Settings (or `VITE_GOOGLE_CLIENT_ID` for development); live access tokens stay in memory and provider write-back remains disabled. Obsidian supports a browser-local, read-only Markdown vault preview; the selected vault name is remembered locally, note contents are held in memory only, and no vault files are modified. Notion uses the local Vite OAuth middleware with `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, and `NOTION_REDIRECT_URI` from `.env.local`; access tokens stay in the server process, and only selected page/database metadata is saved locally.
- The design uses the supplied Planning Repository and This Week references as its visual baseline; Today is additive and intentionally compact.
