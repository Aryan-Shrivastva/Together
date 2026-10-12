# Together — Real-Time Collaborative Development Workspace
## Project Workflow & Build Specification

> **Instructions to the LLM reading this document:** You are the lead engineer building this project. Read the whole document first. Build in the order given in Section 9 (Phase 1 first, Phase 2 only after Phase 1 is complete and working). Do not skip ahead. Obey the guardrails in Section 8.5 at every step, and end every step with the Post-Step Protocol (Section 8.5-C), then stop and wait for confirmation. After each step, make sure the app runs and the step's acceptance criteria pass before moving on. When a choice is given, use the **Decision** stated here, do not substitute other technologies.

---

## 1. Project Summary

**Together** is a browser-based, real-time collaborative IDE for hackathon and small project teams. A team member signs in with GitHub, creates a workspace from a GitHub repository, and invites teammates. Everyone then edits the same files at the same time, sees each other's cursors, and chats inside the workspace, without anyone cloning, installing, or syncing anything on their own laptop.

**Team:** Aryan (230836), Akshit Wadhwa (230784), Pratima (230807)

---

## 2. Why We Are Building This

### The problem
- In hackathons, 24-hour events, and small projects, the latest code, datasets, libraries, and config often live on only one person's laptop.
- Teammates repeatedly download datasets, clone/pull repos, install dependencies, and fix their environments by hand.
- This wastes time and causes outdated files, merge conflicts, and "works on my machine" bugs.
- Git gives version control, but not a shared place to work on code, data, chat, and testing together.

### Why existing tools are not enough
- **Git/GitHub alone:** versioning only; no live shared workspace.
- **VS Code Live Share:** needs the host's machine to stay online; the environment still lives on one laptop.
- **Replit / Codespaces / Gitpod:** powerful, but heavy, paid, or not built around quick team onboarding with GitHub branch/preview/merge flow.

### Our answer
One shared online workspace where code, files, and (later) the execution environment live in one place. Join with a link, start working immediately, test safely on temporary branches, then merge or discard.

---

## 3. Two-Phase Plan Overview

| | **Phase 1 — Mid-Sem** | **Phase 2 — Final** |
|---|---|---|
| **Theme** | "Collaborative IDE foundation" | "Shared environment + safe testing" |
| **Goal** | Prove we can sign in, pull a real GitHub repo into a shared workspace, and let multiple people edit it live | Make the workspace executable, branch-aware, and mergeable |
| **Demo statement** | "Two users sign in, open the same cloned repo, edit the same file simultaneously, see each other, chat, and save/commit to GitHub." | "A team shares one environment, runs the project, tests changes on an isolated branch preview, then merges or discards." |

**Rule:** Phase 1 must be a complete, stable, demo-able product on its own. Phase 2 extends it without rewriting it. Design Phase 1 code so Phase 2 features plug in (see Section 10).

---

## 4. Phase 1 (Mid-Sem) — Scope

### 4.1 In scope
1. **Authentication**: Sign in with GitHub (OAuth). Session via JWT in an httpOnly cookie.
2. **User dashboard**: list of workspaces the user owns or has joined; button to create a new workspace.
3. **Workspace creation from GitHub**: user picks one of their repos (or pastes a repo URL); the server **clones it** into a server-side workspace directory.
4. **Workspace membership & invites**: owner generates an invite link; teammates open it (after signing in) and join as collaborators. Roles: `owner`, `collaborator`.
5. **File explorer**: tree view of the cloned repo; create, rename, delete files and folders.
6. **Code editor**: Monaco Editor with syntax highlighting, tabs for open files.
7. **Real-time collaborative editing**: multiple users edit the same file at once with no conflicts, using a CRDT (Yjs). Shows remote cursors and selections with user name and colour.
8. **User presence**: list of who is online in the workspace and which file each person has open.
9. **Workspace chat**: simple real-time group chat inside the workspace, with history saved.
10. **Persistence**: edits are saved to the server's workspace files automatically (debounced) so nothing is lost on refresh or restart.
11. **Basic Git actions (from the UI)**: view changed files (git status), commit with a message, and push to the GitHub repo using the owner's token. Pull latest from remote.
12. **Basic deployment**: runs locally with Docker Compose.

### 4.2 Explicitly OUT of scope for Phase 1
- Running/executing code, terminals, installing dependencies
- Docker-per-workspace execution, preview environments
- Branch create/merge/discard workflow UI (only commit + push + pull on the current branch)
- Dataset upload / cloud object storage
- Voice/video, comments, advanced permissions

### 4.3 Phase 1 acceptance criteria (the mid-sem demo checklist)
- [ ] User A signs in with GitHub and sees their dashboard.
- [ ] User A creates a workspace from a real GitHub repo; the repo appears in the file explorer within a reasonable time.
- [ ] User A generates an invite link; User B (different browser/account) signs in and joins.
- [ ] Both open the same file; typing from either appears on the other's screen in under ~300 ms (local network).
- [ ] Both see each other's coloured cursor and name, and the online-users list.
- [ ] Both can chat; history survives a page refresh.
- [ ] Refreshing the page or restarting the server keeps all edits.
- [ ] Creating/renaming/deleting a file by one user appears for the other user.
- [ ] Owner can commit and push; the commit appears on GitHub.
- [ ] Whole app starts with one command (`docker compose up`).

---

## 5. Phase 2 (Final) — Scope

### 5.1 In scope
1. **Shared execution environment**: each workspace gets its own Docker container with the project's runtime (Node/Python, etc.) and dependencies installed once, shared by everyone.
2. **Integrated terminal and run/test**: collaborators can run commands, start the app, run tests; output is streamed live to everyone in the workspace.
3. **Dependency & config management**: detect `package.json` / `requirements.txt` etc., install once for the whole team; shared `.env`/config editing (secrets masked).
4. **Dataset & large-file support**: upload datasets to cloud object storage (S3-compatible, e.g. MinIO locally); mounted/accessible inside the workspace container.
5. **Branch workflow**: create a temporary branch for a task, work on it, see diff against main.
6. **Isolated preview**: run the full project from a branch in a separate container with its own preview URL, without touching main.
7. **Merge or discard**: merge branch into main (via GitHub API / git) or discard it and clean up its preview.
8. **Project export/download**: download the workspace as a zip.
9. **Improvements**: role permissions (e.g. read-only viewers), resource limits, idle workspace shutdown, activity log.
10. **Production deployment**: Docker images + cloud hosting.

### 5.2 Phase 2 acceptance criteria
- [ ] Opening a workspace starts (or reuses) its container; dependencies are installed once.
- [ ] Any collaborator can run a command and everyone sees the output live.
- [ ] A user creates a branch, edits, and launches a preview that runs the branch in isolation; main is unaffected.
- [ ] The branch can be merged into main or discarded, and its preview/container is cleaned up.
- [ ] A dataset uploaded by one user is readable from inside the workspace by all.
- [ ] Workspace can be exported as a zip.
- [ ] Containers have CPU/memory limits and cannot reach other workspaces.

---

## 6. Technology Decisions (use exactly these)

| Area | Decision | Reason |
|---|---|---|
| Frontend | React + TypeScript + Vite + Tailwind CSS | Fast dev, typed, matches proposal |
| Editor | **Monaco Editor** (`@monaco-editor/react`) | VS Code-quality editing, good Yjs binding |
| Collaboration (CRDT) | **Yjs** + `y-monaco` + `y-websocket` (server-side via `ws`) | Conflict-free live editing, cursors/awareness built in |
| Chat, presence events, file-tree events | **Socket.IO** | Simple rooms and events |
| Backend | Node.js + Express + TypeScript | Matches proposal |
| Database | **PostgreSQL** with **Prisma** ORM | Relational data (users, workspaces, members, messages) |
| Auth | GitHub OAuth, JWT (httpOnly cookie), Octokit | Matches proposal; needed for repo access |
| Git operations (server) | `simple-git` (clone/status/commit/push/pull) | Easy programmatic git |
| Workspace file storage (Phase 1) | Server disk volume, one folder per workspace | Simplest; real repo on disk |
| Dataset storage (Phase 2) | S3-compatible object storage (MinIO locally) | Matches "cloud object storage" |
| Execution (Phase 2) | Docker via `dockerode` | Isolated per-workspace containers |
| Terminal (Phase 2) | `xterm.js` on frontend + pty in container via WebSocket | Real terminal experience |
| Deployment | Docker Compose (local), cloud VM/container host (final) | |

---

## 7. System Architecture

```
 Browser (React + Monaco + Yjs + Socket.IO client)
        │ HTTPS REST            │ WebSocket (Yjs)        │ WebSocket (Socket.IO)
        ▼                       ▼                        ▼
 ┌────────────────────────────────────────────────────────────────┐
 │                   Node.js / Express server                     │
 │  Auth & REST API │ Yjs WS server │ Socket.IO (chat/presence/fs)│
 │  Workspace Service │ Git Service │ (Phase 2) Runner Service    │
 └───────┬───────────────────┬──────────────────┬─────────────────┘
         ▼                   ▼                  ▼
   PostgreSQL        Workspace disk volume   (Phase 2) Docker Engine
 (users, workspaces,  /data/workspaces/<id>/   + MinIO/S3 storage
  members, messages)  (real git repo)
```

### Key design principle
**The server-side workspace folder (a real git repository) is the single source of truth for files.** Yjs documents are the live, in-memory editing layer on top of it. On open, a file's contents load into a Yjs doc; on change, the server debounces (e.g. 1–2 s) and writes the merged text back to disk. This is what makes git commit/push, and later execution inside Docker, work on the same files everyone is editing.

---

## 8. Data Model (Prisma, Phase 1)

```
User            id, githubId (unique), username, avatarUrl, email?,
                githubAccessTokenEncrypted, createdAt
Workspace       id, name, repoFullName (e.g. "org/repo"), repoCloneUrl,
                defaultBranch, ownerId → User, diskPath, status
                (CLONING | READY | ERROR), createdAt
WorkspaceMember id, workspaceId, userId, role (OWNER | COLLABORATOR), joinedAt
                unique(workspaceId, userId)
Invite          id, workspaceId, token (unique, random), createdById,
                expiresAt, revoked
ChatMessage     id, workspaceId, userId, content, createdAt
```
Phase 2 additions: `Branch`, `Preview`, `Dataset`, `ActivityLog`, `Container` tables (do not create now).

---

## 8.5 Mandatory Guardrails & Post-Step Protocol (READ BEFORE EVERY STEP)

### A. Scope discipline
- Do **ONLY** the step you were asked to do. Do not create routes, UI, tables, or features that belong to later steps, even if "it would be helpful".
- Do not add technologies not listed in Section 6. Do not rewrite or refactor code from earlier steps unless the current step requires it; if it does, say so explicitly.
- Do not start Phase 2 work until the full Phase 1 checklist (Section 4.3) passes.
- Never claim something works unless you have actually run it or given exact commands for me to verify it. If you are unsure, say "unverified".

### B. Never-do list (applies to every step)
1. **Never log, print, return, or commit GitHub tokens or any secret.** Never send tokens to the browser. Store them encrypted only. Never commit `.env` (only `.env.example`).
2. **Never accept a file path without validating it** against the workspace root. Reject `..`, absolute paths, and symlinks that escape the root.
3. **Never skip authentication AND workspace-membership checks** on any REST route, Socket.IO event, or Yjs connection. A missing check leaks other teams' code.
4. **Never trust client input.** Validate everything with zod; do not build shell commands or git commands by string-concatenating user input (use argument arrays / library APIs).
5. **Never let the Yjs document and the disk file drift apart.** Disk is the source of truth on load; flush dirty docs to disk before commit, pull, push, export, or shutdown; reload docs after pull or external changes.
6. **Never leave placeholder code, fake data, `TODO` stubs, or mocked auth** in a finished step. If something cannot be completed, say so clearly instead of faking it.
7. **Never swallow errors silently.** Show clear error states to the user and log safe, useful messages server-side.
8. **(Phase 2) Never run containers in privileged mode, never mount the Docker socket into a workspace container, and never run workspace code without CPU/memory/pid limits and network isolation.**
9. **(Phase 2) Never leave containers, previews, worktrees, or branches running after discard/idle timeout.** Always clean up.
10. Never hardcode ports, paths, secrets, or URLs; use the config module and environment variables.

### C. Post-step protocol (do this at the END of every step, in this exact format)
After finishing a step, reply with:
1. **Files created/changed:** list every file.
2. **How to run & verify:** exact commands and the manual test to perform (use two browsers/accounts for collaboration steps).
3. **Acceptance check:** go through the step's ✅ Verify list and mark each item PASS / FAIL / NOT TESTED.
4. **Guardrail self-check:** confirm each of these, answering YES/NO and fixing any NO before finishing:
   - [ ] No secrets or tokens logged, returned, or committed
   - [ ] Every new route/socket/Yjs entry checks authentication and workspace membership
   - [ ] Every file path is validated against the workspace root
   - [ ] All inputs validated with zod
   - [ ] No code from a later step was added
   - [ ] Disk and Yjs state stay in sync (if the step touches files/editing)
   - [ ] Errors are handled and shown, not swallowed
   - [ ] App still starts with `docker compose up`
5. **Known issues / risks:** be honest about anything incomplete or fragile.
6. **Next step:** name it, then **STOP and wait** for my confirmation. Do not continue on your own.

### D. Edge conditions to test (when the step touches them)
Page refresh mid-edit, server restart, two users editing the same line, user losing connection and reconnecting, a non-member trying to access a workspace, invalid or expired invite, a huge file, and a repo that fails to clone.

---

## 9. Build Order (step-by-step for the LLM)

Work through these steps in order. Each step lists what to build and how to verify it.

### PHASE 1

**Step 1 — Project scaffold**
- Monorepo layout:
  ```
  together/
    client/        (React + Vite + TS + Tailwind)
    server/        (Express + TS)
    docker-compose.yml   (postgres, server, client)
    .env.example
    README.md
  ```
- Add ESLint/Prettier, TypeScript strict mode, a `/health` endpoint.
- ✅ Verify: `docker compose up` runs everything; client loads and calls `/health`.
- ⛔ **Do NOT:** add auth, database models, routes beyond `/health`, or any feature code. Do NOT commit `.env`. Do NOT add libraries outside Section 6.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 2 — Database & Prisma**
- Set up PostgreSQL and Prisma schema from Section 8; run migrations.
- ✅ Verify: tables exist; a seed script can insert and read a user.
- ⛔ **Do NOT:** Do NOT create API routes, auth, or UI. Do NOT add Phase 2 tables (Branch, Preview, Dataset, etc.). Do NOT store raw GitHub tokens in plain-text columns (the column holds encrypted data only).
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 3 — GitHub OAuth authentication**
- Register a GitHub OAuth App (request scopes `read:user user:email repo`). Endpoints: `GET /auth/github`, `GET /auth/github/callback`, `POST /auth/logout`, `GET /api/me`.
- On callback: upsert User, **encrypt** and store the GitHub access token (AES-256-GCM with key from env), issue JWT in an httpOnly, SameSite cookie.
- Auth middleware protects `/api/*`; React has `AuthContext` and a protected-route wrapper.
- ✅ Verify: sign in, see your name/avatar, refresh stays signed in, logout works.
- ⛔ **Do NOT:** Do NOT store the GitHub token unencrypted or put it in the JWT/cookie/browser. Do NOT log the OAuth code or token. Do NOT use localStorage for the JWT (httpOnly cookie only). Do NOT build the dashboard or workspace features yet.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 4 — Dashboard & workspace creation (clone)**
- `GET /api/repos`: list the signed-in user's GitHub repos via Octokit.
- `POST /api/workspaces` `{ repoFullName }`: create Workspace row with status `CLONING`, then clone with `simple-git` into `/data/workspaces/<id>` using the owner's token (never log the token; clone URL with token must not be stored). Update status to `READY` or `ERROR`. Also add the owner as `OWNER` member.
- `GET /api/workspaces` (mine + joined), `GET /api/workspaces/:id`.
- UI: dashboard with workspace cards, "New workspace" modal showing repo list, clone progress/status polling.
- ✅ Verify: pick a repo, status goes CLONING → READY, folder exists on disk with the repo's files.
- ⛔ **Do NOT:** Do NOT save the token-embedded clone URL in the database or logs. Do NOT clone synchronously inside the request (it must be async with status). Do NOT allow cloning into a path outside `/data/workspaces/<id>`. Do NOT build invites, editor, or file APIs yet. Handle clone failure (bad repo, no access, timeout) by setting status ERROR with a clear message.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 5 — Membership & invites**
- `POST /api/workspaces/:id/invites` (owner only) returns a link `/join/<token>`; `POST /api/join/:token` adds the user as COLLABORATOR; owner can revoke.
- All workspace endpoints/sockets must check membership.
- ✅ Verify: second account joins via link and sees the workspace on their dashboard; non-members get 403.
- ⛔ **Do NOT:** Do NOT make invite tokens guessable (use long random values). Do NOT let revoked/expired invites work. Do NOT let collaborators perform owner-only actions. Do NOT forget to enforce membership checks on ALL existing workspace endpoints.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 6 — File explorer & file API**
- REST: `GET /api/workspaces/:id/tree`, `GET /file?path=`, `POST /file` (create), `PATCH /file` (rename/move), `DELETE /file`.
- **Security:** resolve every path against the workspace root and reject anything that escapes it (path traversal), ignore `.git` in the tree, cap file size for opening.
- Emit Socket.IO `fs:changed` events to the workspace room so all clients refresh the tree.
- UI: collapsible tree, context menu (new/rename/delete), live updates.
- ✅ Verify: one user creates a file; the other sees it instantly.
- ⛔ **Do NOT:** Do NOT concatenate user paths directly into disk paths; always resolve and verify against the workspace root. Do NOT expose or allow editing `.git`. Do NOT read huge/binary files into the editor without a size/type check. Do NOT implement the editor or Yjs yet.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 7 — Monaco editor & tabs**
- Workspace page layout: left file tree, centre editor with tabs, right panel (chat/users), top bar (workspace name, branch, Git buttons).
- Language detection from file extension; dark theme.
- ✅ Verify: open several files in tabs, edit them locally.
- ⛔ **Do NOT:** Do NOT add real-time sync yet (local editing only). Do NOT introduce another editor library. Do NOT load whole large files without a size limit.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 8 — Real-time collaborative editing (the core feature)**
- Run a Yjs WebSocket server in the Express server (route `/yjs/<workspaceId>`), authenticate the connection with the same JWT cookie and membership check.
- One Yjs `Y.Doc` per **(workspace, file path)**. Load initial text from disk when the doc is first created; bind Monaco via `y-monaco`.
- Use Yjs **awareness** for cursor/selection with user name + colour (derived from user id).
- **Persistence:** on doc updates, debounce 1–2 s and write the text to the file on disk; on server shutdown flush all dirty docs. When the last client leaves, keep the doc a short while then unload it.
- Handle external disk changes (e.g. after `git pull`): reload affected docs and push the new content to clients.
- ✅ Verify: two browsers type in the same file simultaneously with no lost characters; remote cursors visible; kill and restart the server and edits are on disk.
- ⛔ **Do NOT:** Do NOT let unauthenticated or non-member clients connect to the Yjs server. Do NOT write to disk on every keystroke (debounce). Do NOT overwrite disk content with an empty/uninitialized doc on load. Do NOT forget to flush on shutdown. Do NOT create one doc per user (one Y.Doc per workspace+file). Do NOT break file-path validation from Step 6.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 9 — Presence & chat**
- Socket.IO namespace/rooms per workspace. Events: `presence:update` (who is online, which file open), `chat:send`, `chat:message`. Persist messages in `ChatMessage`; `GET /api/workspaces/:id/messages?before=` for history.
- UI: online users avatars in top bar, chat panel with auto-scroll and timestamps.
- ✅ Verify: join/leave updates the user list; chat history persists after refresh.
- ⛔ **Do NOT:** Do NOT broadcast messages or presence to rooms the user has not joined/been authorized for. Do NOT trust the client-sent user id/name (use the authenticated session). Do NOT store unsanitized HTML from chat (escape/render as text). Do NOT load unlimited chat history (paginate).
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 10 — Basic Git panel**
- Endpoints: `GET /git/status`, `POST /git/commit` `{message, files?}`, `POST /git/push`, `POST /git/pull`. Use the **owner's** stored token for push/pull (only owner can push in Phase 1). Set the commit author to the acting user's GitHub name/email.
- Before commit/pull, **flush all dirty Yjs docs to disk**; after pull, refresh docs and tree.
- UI: source-control panel listing changed files with a status badge, commit box, Push / Pull buttons, and clear error messages (e.g. conflicts, auth failure).
- ✅ Verify: edit together, commit, push; the commit shows on GitHub.
- ⛔ **Do NOT:** Do NOT use the commit/push token of a user who is not the owner in Phase 1. Do NOT pass user text to git via a shell string (use simple-git args). Do NOT commit or pull before flushing dirty Yjs docs. Do NOT push to a branch/remote the user did not choose. Do NOT hide git errors (conflicts, auth failure); show them. Do NOT build branch create/merge/discard UI (Phase 2).
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 11 — Hardening, polish, demo prep (mid-sem)**
- Loading/error states, reconnect handling (Yjs and Socket.IO auto-reconnect and a "reconnecting…" banner), basic rate limiting, input validation (zod), CORS/cookie config, clean logs (no secrets).
- README with setup instructions and a demo script.
- ✅ Verify: run the full Phase 1 acceptance checklist (Section 4.3).
- ⛔ **Do NOT:** Do NOT add new features. Do NOT leave debug logs containing secrets. Do NOT skip testing reconnects, refresh, and restarts. Do NOT mark Phase 1 complete unless EVERY item in Section 4.3 passes.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**🏁 MID-SEM MILESTONE: Phase 1 complete. Tag the repo `v1-midsem`.**

---

### PHASE 2 (start only after the Phase 1 checklist passes)

**Step 12 — Workspace container runtime**
- Add a Runner service using `dockerode`. Each workspace maps to one container created from a base image (start with Node + Python), with the workspace folder bind-mounted at `/workspace`. Start on demand, stop after idle timeout. Apply CPU/memory/pid limits and a per-workspace network.
- Detect `package.json` / `requirements.txt` / `pyproject.toml` and offer a one-click **Install dependencies** (run once; shared by all).
- ✅ Verify: open workspace → container starts; install runs once and everyone sees the same installed environment.
- ⛔ **Do NOT:** Do NOT start before Phase 1 is verified complete. Do NOT run containers privileged or mount the Docker socket inside them. Do NOT run without CPU/memory/pid limits. Do NOT let one workspace's container reach another's files or network. Do NOT leave idle containers running.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 13 — Shared terminal & run/test**
- `xterm.js` terminal over WebSocket attached to a shell in the container; plus "Run" and "Test" buttons that run configured commands (default detected from project; editable in a `together.json`).
- Output streamed to all collaborators in the room; show who ran what.
- ✅ Verify: User A runs `npm test`; User B sees the live output.
- ⛔ **Do NOT:** Do NOT give the terminal access to the host. Do NOT let non-members or viewers attach to a terminal. Do NOT stream output to users outside the workspace room. Do NOT allow unbounded output buffering (cap it).
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 14 — Config & datasets**
- Shared env/config editor (secrets stored encrypted, masked in UI, injected into the container).
- Dataset upload (chunked/large-file friendly) to MinIO/S3; list, delete, and make them available in the container (mounted read-only at `/datasets` or synced on demand).
- ✅ Verify: upload a CSV; run a script inside the container that reads it.
- ⛔ **Do NOT:** Do NOT show secrets in plain text in the UI or logs. Do NOT bake secrets into images. Do NOT allow unlimited upload sizes or path-unsafe dataset names. Do NOT make the datasets mount writable if not needed.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 15 — Branch workflow**
- UI/API to create a temporary branch (`together/<user>/<task>`), switch, view diff vs main, commit and push the branch. Each branch can have its own working copy (git worktree) so main stays untouched.
- ✅ Verify: branch edits do not change main's working files.
- ⛔ **Do NOT:** Do NOT switch the shared main working copy when a user creates a branch (use a separate worktree). Do NOT allow unsafe branch names (validate). Do NOT lose uncommitted collaborative edits when switching; flush and warn first.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 16 — Isolated preview**
- "Launch preview" starts a separate container from the branch's working copy, runs the configured start command, and exposes it via a proxied preview URL (e.g. `/preview/<previewId>`), auto-stopping after idle time.
- ✅ Verify: preview shows the branch's changes while main is unchanged.
- ⛔ **Do NOT:** Do NOT expose preview containers without authentication/membership checks. Do NOT let a preview touch main's files or other previews. Do NOT leave previews running after idle timeout or discard. Do NOT run previews with elevated privileges.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 17 — Merge / discard**
- Merge: open a PR via Octokit and/or merge locally then push; handle conflicts with a clear error and guidance. Discard: delete branch (local and optionally remote), stop preview, remove worktree and containers.
- ✅ Verify: merged changes appear on main; a discarded branch leaves no containers or files behind.
- ⛔ **Do NOT:** Do NOT merge without showing the diff/confirmation. Do NOT delete a branch/preview without confirmation. Do NOT leave worktrees, containers, or remote branches behind after discard. Do NOT hide merge conflicts; report them clearly.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 18 — Export & permissions**
- Zip download of the workspace (excluding `node_modules`, `.git` optional). Add VIEWER role (read-only). Activity log.
- ✅ Verify: exported zip opens correctly; viewer cannot edit.
- ⛔ **Do NOT:** Do NOT include secrets, `node_modules`, or other users' data in the export. Do NOT let VIEWERs write via any route, socket, or Yjs connection (enforce server-side, not just in the UI).
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**Step 19 — Security hardening & deployment**
- Container isolation review (no privileged mode, no Docker socket in workspace containers, drop capabilities, resource caps, network isolation), secrets management, HTTPS, production Docker images, deploy to a cloud host, backups.
- ✅ Verify: full Phase 2 acceptance checklist (Section 5.2) on the deployed instance.
- ⛔ **Do NOT:** Do NOT deploy with default/dev secrets, open Docker ports, or debug mode on. Do NOT skip HTTPS. Do NOT expose the database publicly. Re-run the whole security checklist and both acceptance checklists before declaring done.
- 📋 When finished, follow the **Post-Step Protocol (Section 8.5-C)** and then STOP.

**🏁 FINAL MILESTONE: tag `v2-final`.**

---

## 10. Designing Phase 1 So Phase 2 Fits

- Keep a **WorkspaceService** abstraction (`getRoot(workspaceId)`, `readFile`, `writeFile`, …) so the same code works on a plain folder now and a container-mounted folder later.
- Keep a **GitService** that takes a working-directory path as a parameter, so branch worktrees in Phase 2 reuse it.
- Keep the Socket.IO room structure `workspace:<id>` and make events namespaced (`chat:*`, `presence:*`, `fs:*`) so `terminal:*`, `run:*`, `preview:*` can be added later.
- Store workspace `status` as an enum that can later include `STARTING`, `RUNNING`, `STOPPED`.
- Do not hardcode paths; use a config module with env variables.

---

## 11. Suggested Folder Structure

```
server/src/
  index.ts                 # app bootstrap
  config/                  # env loading & validation
  auth/                    # github oauth, jwt, middleware
  routes/                  # auth, workspaces, files, git, invites, chat
  services/
    workspaceService.ts    # disk paths, safe path resolution
    gitService.ts          # simple-git wrapper
    githubService.ts       # octokit wrapper
    yjsService.ts          # y-websocket server, persistence
    chatService.ts
    crypto.ts              # token encryption
  sockets/                 # socket.io handlers (presence, chat, fs)
  prisma/schema.prisma
client/src/
  pages/                   # Login, Dashboard, Workspace, Join
  components/              # FileTree, EditorTabs, ChatPanel, PresenceBar, GitPanel
  hooks/                   # useAuth, useYjsFile, useSocket
  lib/                     # api client, socket, yjs setup
```

---

## 12. Security & Quality Rules (apply to everything)

1. Never expose or log GitHub tokens; store encrypted; never send them to the browser.
2. All file paths are validated against the workspace root (block `..`, absolute paths, symlink escapes).
3. Every REST route, Socket.IO event, and Yjs connection must check authentication **and** workspace membership.
4. Validate all inputs with zod; return consistent error JSON.
5. Rate-limit auth, invite, chat, and git endpoints.
6. Use environment variables for all secrets; provide `.env.example`.
7. Write clean, typed, commented code; small modules; no unused dependencies.
8. Add basic tests for: path safety, auth middleware, invite flow, git service, and the file API.
9. Keep a `CHANGELOG`/progress log: after each step, note what was done and what is next.

---

## 13. Risks & How We Handle Them

| Risk | Mitigation |
|---|---|
| Yjs doc and disk file go out of sync | Disk is source of truth on load; debounced flush; flush before git ops; reload after pull |
| Large repos clone slowly | Show clone progress/status; use shallow clone (`--depth`) option for Phase 1 |
| Git conflicts on pull | Surface clear error; Phase 1 requires clean state before pull |
| GitHub token leakage | Encryption at rest, no logging, server-side only |
| Malicious code run in Phase 2 | Containers with limits, no privileged mode, isolated networks |
| Scope creep before mid-sem | Phase 1 scope list in Section 4 is fixed; anything else goes to Phase 2 |

---

## 14. Team Split Suggestion (3 members)

| Member | Phase 1 focus | Phase 2 focus |
|---|---|---|
| **Aryan** | Auth, DB, workspace creation, invites, Docker Compose | Container runtime, deployment, security |
| **Akshit** | Yjs collaboration, Monaco, persistence, presence | Terminal, run/test streaming, preview |
| **Pratima** | UI/UX (dashboard, file tree, chat, git panel), Socket.IO chat | Branch workflow, merge/discard, datasets, export |

---

## 15. Mid-Sem Demo Script (5–7 minutes)

1. Sign in with GitHub as User A. Show dashboard.
2. Create a workspace from a real repo; show clone completing.
3. Copy invite link; open in a second browser as User B; join.
4. Both open the same file; type simultaneously; point out coloured cursors and presence list.
5. Create a new file as A; show it appear for B instantly.
6. Chat between A and B.
7. Refresh the page and restart the server container to show persistence.
8. Commit and push as the owner; open GitHub to show the commit.
9. Close with a slide: "Phase 2 → shared run environment, branch previews, merge/discard."

---

## 16. Definition of Done

- **Phase 1 done:** every item in Section 4.3 passes, README is complete, repo tagged `v1-midsem`.
- **Phase 2 done:** every item in Section 5.2 passes on the deployed instance, repo tagged `v2-final`.
