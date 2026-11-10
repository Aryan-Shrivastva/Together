# Together

Together is a browser-based, real-time collaborative development workspace for small teams. A workspace owner signs in with GitHub, clones a repository into the shared server workspace, invites teammates, and collaborates through a file explorer, Monaco editor, live cursors, chat, and basic Git actions.

## Phase 1 capabilities

- GitHub OAuth with an encrypted server-side access token and an httpOnly session cookie.
- Create a server-side workspace from a GitHub repository and invite collaborators.
- Shared file tree with create, rename, move, and delete actions.
- Monaco editor tabs with Yjs-powered simultaneous editing, remote cursors, and disk persistence.
- Presence and persistent workspace chat.
- Git status, commit-all, pull, and owner-only push from Source Control.
- Docker Compose startup with PostgreSQL, the API server, and the browser client.
- A per-workspace restricted Node/Python runtime that starts on workspace open and can install detected dependencies once for the team.

The shared terminal and detected Run/Test commands are available inside a workspace. Branches, previews, datasets, and export are introduced in later Phase 2 steps.

## Prerequisites

- Docker Desktop with Docker Compose.
- A GitHub OAuth App. Node.js 22+ and npm are only needed for local quality checks.

## Configuration

1. Copy the example environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

2. In `.env`, set a private `POSTGRES_PASSWORD`, GitHub OAuth values, and independent Base64-encoded 32-byte values for `JWT_SECRET` and `TOKEN_ENCRYPTION_KEY`.

3. In GitHub, create an OAuth App that requests `read:user`, `user:email`, and `repo` access.

For local use, configure these URLs:

| Setting                            | Value                                        |
| ---------------------------------- | -------------------------------------------- |
| Homepage URL                       | `http://localhost:5173`                      |
| Authorization callback URL         | `http://localhost:4000/auth/github/callback` |
| `.env` `CORS_ORIGIN`               | `http://localhost:5173`                      |
| `.env` `GITHUB_OAUTH_REDIRECT_URL` | `http://localhost:4000/auth/github/callback` |

For an ngrok or other public HTTPS tunnel, replace both GitHub App URLs and both matching `.env` URL values with that exact public origin. Add the tunnel hostname to `VITE_ALLOWED_HOSTS`. A changed public tunnel URL requires updating these settings and signing in again.

Never commit `.env` or share client secrets, JWT secrets, encryption keys, OAuth codes, or GitHub access tokens.

## Production deployment

Production uses the separate hardened compose file. Copy `.env.production.example` to `.env.production`, replace every placeholder with unique secret values, point `PUBLIC_HOST` and `PUBLIC_ORIGIN` at a DNS name for this server, and register the HTTPS GitHub callback URL. Caddy obtains and renews the TLS certificate automatically.

```powershell
Copy-Item .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

The production gateway is the only published application service. PostgreSQL, MinIO, the API, and the static client stay on private Docker networks; workspace containers receive their own internal network, resource limits, read-only root filesystem, dropped capabilities, and no Docker socket. The API server talks to a restricted Docker API proxy rather than mounting the Docker socket directly.

Create encrypted/off-host backups from the deployment host with:

```powershell
./scripts/backup.ps1
```

Protect the backup directory like the database: it contains workspace source and database records. Test restore procedures separately before relying on a backup for recovery.

## Start the application

```powershell
docker compose up --build
```

Open `http://localhost:5173`. The client builds once when the container starts, then serves optimized static assets. The API is available through the client proxy, so users only need the browser URL.

## Shared terminal and tasks

The Terminal panel opens one shell inside the workspace's restricted Docker runtime. Every workspace member sees its output and can type into the same shell; commands never execute on the Together server or host machine.

Run and Test buttons are detected from `package.json` (`dev` or `start` for Run, `test` for Test). A repository can override them with safe command arrays in a root-level `together.json`:

```json
{
  "run": ["npm", "run", "dev"],
  "test": ["npm", "test"]
}
```

Only workspace members can attach, send input, or receive terminal output. Output history is capped in memory so a noisy command cannot grow the server indefinitely.

To stop services while keeping the database and workspace volume:

```powershell
docker compose down
```

## Git workflow in Together

1. Open **Source Control** from the left activity bar.
2. Review changed files.
3. Enter a message and choose **Commit all changes**. This performs the equivalent of `git add .` and `git commit` inside the server-side workspace.
4. The workspace owner chooses **Push** to send commits to the repository's current branch.
5. Choose **Pull** before working with newer remote commits. Resolve any reported conflict before retrying.

The OAuth token is stored encrypted on the server and is never sent to the browser. If push says GitHub authentication failed, sign out and sign in with GitHub again to refresh the stored token.

## Shared runtime

Opening a ready workspace starts (or reuses) its dedicated Node/Python container. The bottom panel reports its status and offers **Install dependencies** when it detects `package.json`, `requirements.txt`, or `pyproject.toml`. The runtime has CPU, memory, process, filesystem, and per-workspace network limits; it stops after inactivity.

Interactive terminal commands and shared command output are the next Phase 2 step.

## Branch previews

Open a temporary task branch, install its dependencies, then use **Launch preview** in the Terminal panel. Together starts a separate restricted container for that branch and opens it through an authenticated `/preview/...` URL. The preview has its own network and working copy, so it cannot change the main workspace. It stops automatically after inactivity or when **Stop preview** is selected.

For projects that do not use the default Vite development server, add a root-level `together.json` with a safe argument-array command and port:

```json
{
  "preview": { "command": ["python3", "-m", "http.server", "8000", "--bind", "0.0.0.0"], "port": 8000 }
}
```

## Mid-sem demo script

1. Sign in as User A and create a workspace from a real repository.
2. Generate an invite and join from a second browser using User B.
3. Both users open the same file, type simultaneously, and point out remote cursors and online presence.
4. Create a file as User A and show it appear for User B.
5. Exchange chat messages, refresh User B's page, and show history remains.
6. Refresh a page or restart the API container and show edits remain in the file.
7. As User A, commit and push; verify the commit on GitHub.
8. Explain that shared execution, branch previews, and merge/discard are Phase 2 work.

## Verification and quality checks

```powershell
npm run lint
npm run build
npm run format:check
```

For the full Phase 1 acceptance checklist, use two different GitHub accounts and test collaboration, invites, refresh/restart persistence, file updates, chat history, and Git push.

## Troubleshooting

- **OAuth redirect warning:** The exact browser origin must be registered as the GitHub App callback URL and match `GITHUB_OAUTH_REDIRECT_URL`.
- **Public tunnel blocked by Vite:** Add only the public tunnel hostname to `VITE_ALLOWED_HOSTS`, then recreate the client container.
- **Chat or collaboration says reconnecting:** wait for the browser to reconnect automatically. Reload only if it does not recover.
- **Push fails with authentication:** sign out and sign in again; do not enter a token in the application.
