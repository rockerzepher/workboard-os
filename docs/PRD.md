# Personal Work Operating System — MVP

This repository implements the build-ready MVP specification supplied with the project. The product separates:

- **Context:** Obsidian notes, research, plans, and ideas.
- **Commitments:** Google Tasks titles, due dates, completion, lists, and parent relationships.
- **Control:** local board containers, areas, projects, daily roles, and review metadata.

The six primary verticals are Planning Repository, Today, This Week, Projects, App Ideas / Someday, and Waiting For. Today is a generated daily plan with many quick-clear items, exactly one main outcome, and exactly one evening build. Completed work remains visible in its original container.

The browser foundation uses synthetic data and local browser persistence so the operating model can be exercised without touching external sources. Obsidian context can be selected as a browser-local, read-only Markdown preview, Google Tasks has both a synthetic dry-run preview and a server-side OAuth path using the read-only Tasks scope, and the WorkBoard Sentinel provides a local Attention Queue for read-only review. The Communications Scout adds an optional server-side Gmail read-only scan for recent follow-ups and incoming candidates. Provider write-back and SQLite remain staged behind the current interface. Notion references are scoped read-only context selections.
