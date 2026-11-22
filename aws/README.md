# AWS deployment

This directory contains the Ubuntu setup, production deployment, and backup scripts used on the AWS VM.

- `bootstrap-ubuntu.sh`: install Docker and configure swap on Ubuntu.
- `deploy-production.sh`: build the production services, apply migrations, and start the stack.
- `backup.sh`: back up the database, workspace files, and object storage.

The shared production Compose file and Caddy configuration remain at the repository root: `docker-compose.production.yml` and `Caddyfile`. Their paths are used by the existing AWS deployment. Service images are defined alongside their components in `client/`, `server/`, `runner/`, `storage/`, and `docker-proxy/`. The `scripts/` entry points remain available for compatibility with existing instructions and servers.

Never commit `.env.production`, SSH keys, or deployment state. Runtime and preview containers run on the AWS server; Docker Desktop is not needed on team members' laptops when using the cloud site.
