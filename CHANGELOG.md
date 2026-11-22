# Changelog

## Unreleased — Cloud deployment

- Added Ubuntu bootstrap and sequential production deployment scripts with automatic database migrations.
- Fixed non-root workspace volume ownership, Nginx read-only startup, Docker proxy configuration/PID paths, and API access to outbound GitHub/registry requests.
- Included workspace-local Node dependencies in the production API image and corrected dataset bind paths for the Docker daemon.
- Parsed boolean environment values explicitly so `MINIO_USE_SSL=false` uses HTTP as intended.
- Built MinIO from its official tagged source release instead of unavailable community registry images, and excluded deployment credentials from Docker contexts.

## Unreleased — Team awareness and version notifications

- Made Team chat discoverable with an online count, active-file links, message timestamps, and unread live-message badges.
- Restored chat history and active-file presence on reconnect; kept background terminal/file sockets from hiding a teammate's active file.
- Added persisted per-member notices for commits, pulls, and branch merges, with a refresh action that preserves collaborative edits.
- Added integration coverage for membership, offline notices, chat persistence, viewer restrictions, presence, and version review isolation.

## Unreleased — Phase 2, Step 16

- Added one isolated Docker preview per temporary task branch, exposed only through an authenticated Together proxy route.
- Added launch, open, and stop controls in the branch workspace terminal panel, plus automatic preview idle shutdown.

## Unreleased — Phase 2, Step 12

- Added a per-workspace Docker runtime with Node and Python, secure resource limits, isolated networking, and an idle shutdown timer.
- Added runtime start/status and one-click dependency installation for Node and Python project manifests.

## Unreleased — Phase 1, Step 11

- Added in-memory rate limits for authentication, invite, Git, chat-history, and live chat message traffic.
- Added clear reconnect and error states for live file updates, Yjs collaboration, and chat.
- Improved API handling for validation and hot-reload-safe application errors.
- Documented local/public-tunnel setup, the Phase 1 Git workflow, troubleshooting, and the mid-sem demo.

## Phase 1, Steps 1–10

- Implemented the Docker/React/Express/PostgreSQL foundation, GitHub OAuth, workspace cloning, membership invites, file management, Monaco editing, Yjs collaboration, presence, chat, persistence, and basic Git controls.

## Unreleased — Phase 2, Step 13

- Added an xterm.js shared terminal backed by a shell inside each restricted workspace runtime.
- Stream terminal output only to authenticated workspace members, with bounded in-memory history and input limits.
- Added detected Run/Test commands from package scripts or safe root-level `together.json` command arrays.
