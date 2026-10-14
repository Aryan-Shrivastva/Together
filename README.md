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

Interactive terminals, run/test controls, branches, previews, datasets, and export are introduced in later Phase 2 steps.

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

## Start the application

```powershell
docker compose up --build
```

Open `http://localhost:5173`. The client builds once when the container starts, then serves optimized static assets. The API is available through the client proxy, so users only need the browser URL.

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
