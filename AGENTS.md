# Workboard OS

Workboard OS is a local-first, single-user operating view for commitments from Google Tasks, context from Obsidian, and local planning metadata.

## Working contract

- Read `docs/PRD.md` before changing product behavior.
- Keep provider adapters behind interfaces; the UI must not become the source of truth for Google Tasks or Obsidian.
- Never commit credentials, private task data, vault contents, or imported sync logs.
- Never silently delete, complete, move, or rewrite provider data. Provider writes must be explicit and opt-in.
- Use synthetic fixtures for tests and dry runs.

## Commands

```text
npm install
npm run dev
npm run build
npm test
npm run lint
```

The current UI is a browser-safe foundation with seeded synthetic data. Provider connections and SQLite persistence are intentionally staged for the next implementation phase.
