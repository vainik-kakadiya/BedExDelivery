# Running BedEx on a Google Cloud VM

For a fresh Compute Engine VM (Debian or Ubuntu, 2 vCPU / 4 GB is plenty). The database and photo storage stay on Supabase; the VM runs two containers: the API and Caddy (web app + HTTPS).

**No domain?** The setup script gives the site the address `https://<ip-with-dashes>.sslip.io`, for example `https://34-89-12-7.sslip.io`. [sslip.io](https://sslip.io) is a free DNS service that maps that name to the IP, so Caddy can get a real HTTPS certificate. HTTPS is required: logins and the driver camera don't work without it. To use a real domain later, see [the last section](#later-switching-to-a-real-domain).

## 1. In the Google Cloud console

1. **Give the VM a fixed IP.** The sslip.io address is built from the IP, so it must not change.
   VPC network → **IP addresses** → find the VM's external IP → **⋮ → Promote to static IP address**.
2. **Allow web traffic.** Compute Engine → VM instances → click the VM → **Edit** → *Networking* → tick **Allow HTTP traffic** and **Allow HTTPS traffic** → **Save**.

## 2. Get the code onto the VM

Open an SSH session with the **SSH** button next to the VM.

The GitHub repo is private, so give the VM a read-only key:

```sh
sudo apt-get update && sudo apt-get install -y git
ssh-keygen -t ed25519 -f ~/.ssh/bedex_deploy -N "" -C "bedex-vm"
cat ~/.ssh/bedex_deploy.pub
```

Copy the line it prints. On GitHub, open the repo → **Settings → Deploy keys → Add deploy key**, paste it, and leave *Allow write access* unticked. Then:

```sh
git clone -c core.sshCommand="ssh -i ~/.ssh/bedex_deploy -o StrictHostKeyChecking=accept-new" \
  git@github.com:vainik-kakadiya/BedExDelivery.git ~/bedex
```

## 3. Add your `.env`

`.env` is not in git. In the SSH window, click **Upload file** (the ↑ button at the top) and choose your local `.env`. It lands in your home folder:

```sh
mv ~/.env ~/bedex/.env
```

Nothing else in it needs changing. The production settings (`NODE_ENV`, `COOKIE_SECURE`, `CORS_ORIGIN`, `TRUST_PROXY`) are set by `docker-compose.yml`, and the next step adds `PUBLIC_URL`.

## 4. Set up the VM and start

```sh
cd ~/bedex
bash deploy/setup-server.sh
```

It installs Docker, adds swap, and sets `PUBLIC_URL` to the sslip.io address. **Log out and SSH in again** (so `docker` works without `sudo`), then:

```sh
cd ~/bedex
docker compose up -d --build      # first build takes a few minutes
docker compose ps                 # api should become "healthy"
docker compose logs -f web        # wait for "certificate obtained successfully", then Ctrl+C
```

Open the `PUBLIC_URL` shown by `grep PUBLIC_URL .env` and sign in.

## 5. Google Maps keys

If your keys are restricted (they should be):

- `GOOGLE_MAPS_SERVER_KEY`: under *Application restrictions → IP addresses*, add the VM's static IP.
- `VITE_GOOGLE_MAPS_BROWSER_KEY`: under *Website restrictions*, add `https://<your-sslip-address>/*`.

## Everyday commands

Run these in `~/bedex`:

| Task | Command |
|---|---|
| Update to the latest code | `git pull && docker compose up -d --build` |
| API logs | `docker compose logs -f api` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` |
| Apply new database migrations | `docker compose run --rm tools pnpm db:migrate` |
| Free disk space from old builds | `docker image prune -f` |

The containers restart on their own after a crash or VM reboot.

## Good to know

- **Same database as development.** If `.env` points at the Supabase project you develop against, the live site and your local testing share the same data, demo orders included. For a separate live database, create a new Supabase project, point `DATABASE_URL` / `SUPABASE_*` at it, then run `docker compose run --rm tools pnpm db:migrate` and `… pnpm db:seed` once.
- **`DATABASE_URL` must use Supabase's session pooler** (`…pooler.supabase.com:5432`). Google Cloud VMs have no IPv6, and Supabase's direct `db.<ref>.supabase.co` address is IPv6-only.
- **Certificate not issued?** Usually step 1.2 was skipped: Let's Encrypt must reach the VM on port 80. Fix it, then `docker compose restart web`.

## Later: switching to a real domain

1. Add an `A` record for, say, `delivery.example.com` pointing at the VM's static IP.
2. In `~/bedex/.env`, set `PUBLIC_URL=https://delivery.example.com`.
3. `docker compose up -d`, and update the browser key's website restriction.

Drivers who installed the app from the old address need to open the new one and install again.
