#!/usr/bin/env bash
# One-time setup of a fresh Debian/Ubuntu server (e.g. a Google Cloud VM) for BedEx.
# Run from the project folder:   bash deploy/setup-server.sh
#
#  1. installs Docker (with the compose plugin) if missing
#  2. adds 2 GB of swap if there is none, so image builds don't run out of memory
#  3. creates .env from the template if missing
#  4. sets PUBLIC_URL to https://<ip-with-dashes>.sslip.io if it's empty, so the site
#     gets a real HTTPS certificate without owning a domain
#
# Override the detected address with PUBLIC_IP=1.2.3.4 bash deploy/setup-server.sh
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --- 1. Docker ---
if command -v docker >/dev/null 2>&1; then
  say "Docker already installed: $(docker --version)"
else
  say "Installing Docker…"
  curl -fsSL https://get.docker.com | sudo sh
fi
if ! id -nG "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  NEED_RELOGIN=1
fi

# --- 2. Swap ---
if [ -z "$(swapon --show --noheadings)" ]; then
  say "Adding 2 GB swap…"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
else
  say "Swap already present"
fi

# --- 3. .env ---
if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env from .env.example. Fill in the database, secrets and keys before starting."
fi

# --- 4. PUBLIC_URL ---
current=$(grep -E '^PUBLIC_URL=' .env | head -1 | cut -d= -f2- | tr -d '"' || true)
if [ -n "$current" ]; then
  say "PUBLIC_URL already set: $current"
else
  ip=${PUBLIC_IP:-}
  # Google Cloud metadata server first, then a public lookup.
  [ -z "$ip" ] && ip=$(curl -fs -m 3 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)
  [ -z "$ip" ] && ip=$(curl -fs -m 5 https://api.ipify.org || true)
  if [[ ! "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Could not detect this server's public IP. Run again with PUBLIC_IP=<ip>." >&2
    exit 1
  fi
  url="https://${ip//./-}.sslip.io"
  if grep -qE '^PUBLIC_URL=' .env; then
    sed -i -E "s#^PUBLIC_URL=.*#PUBLIC_URL=${url}#" .env
  else
    printf '\nPUBLIC_URL=%s\n' "$url" >> .env
  fi
  say "PUBLIC_URL set to $url"
fi

say "Done."
if [ "${NEED_RELOGIN:-}" = 1 ]; then
  echo "Log out and back in once (so 'docker' works without sudo), then:"
else
  echo "Next:"
fi
echo "  cd $(pwd) && docker compose up -d --build"
