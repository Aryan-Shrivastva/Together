# Together

Real-time collaborative development workspace for hackathon and small project teams.

## Prerequisites

- Docker Desktop with Docker Compose
- Node.js 22+ and npm 11+ (only needed for local, non-Docker development)

## Start with Docker Compose

1. Copy `.env.example` to `.env`.
2. Set a non-default local `POSTGRES_PASSWORD` in `.env`.
3. Run:

   ```powershell
   docker compose up --build
   ```

4. Open `http://localhost:<CLIENT_PORT>` (by default, `http://localhost:5173`). The page checks and displays the backend health status.

## Local quality checks

```powershell
npm install
npm run lint
npm run build
npm run format:check
```

## GitHub OAuth configuration

Create a GitHub OAuth App with homepage URL `http://localhost:5173` and authorization callback URL `http://localhost:4000/auth/github/callback`. Add its client ID, client secret, and two independently generated Base64-encoded 32-byte secrets to the ignored root `.env` file using the names in `.env.example`.

Never commit `.env`, expose the client secret, JWT secret, encryption key, or GitHub access tokens.

## Current progress

Phase 1 now includes the scaffold, PostgreSQL/Prisma persistence, and GitHub OAuth session flow. Dashboard and workspace features are intentionally not included yet.
