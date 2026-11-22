#!/usr/bin/env bash
# Run on a fresh Ubuntu 24.04 EC2 instance as root.
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then
  echo 'Run this script using sudo.' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 ca-certificates curl
systemctl enable --now docker

# Provide headroom for dependency builds on the 4 GB demo instance.
if [[ ! -f /swapfile ]]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi
