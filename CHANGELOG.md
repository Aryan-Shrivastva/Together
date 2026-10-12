# Changelog

## Unreleased

- Phase 1, Step 1: added the React/Vite/Tailwind client, strict TypeScript Express server,
  PostgreSQL Docker Compose service, linting/formatting, and the `/health` endpoint.
- Phase 1, Step 2: added the Phase 1 Prisma schema, migration/seed scripts, and Docker database URL wiring.
- Phase 1, Step 3: added GitHub OAuth, encrypted server-side GitHub token storage, JWT httpOnly sessions, and client authentication state.
- Phase 1, Step 4: added the authenticated dashboard, GitHub repository selection, validated workspace records and memberships, and asynchronous shallow repository cloning into Docker-managed storage.
- Phase 1, Step 5: added owner-controlled, expiring GitHub workspace invite links, secure collaborator joining, invite revocation, and invite-aware GitHub sign-in return handling.
- Phase 1, Step 6: added member-authorized file tree and file-management APIs, workspace-contained path and file-size safeguards, Socket.IO filesystem notifications, and a live collapsible file explorer.
- Phase 1, Step 7: added a Monaco editor workspace layout, file tabs, language detection, and local-only in-browser drafts.
- Phase 1, Step 8: added authenticated Yjs file documents, Monaco bindings, awareness metadata, debounced disk persistence, file-change reloads, and idle document cleanup.
- Next: Phase 1, Step 9 — Presence & chat.
