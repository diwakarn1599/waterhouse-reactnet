# Deployment

One process, one file, one small VPS. Target cost **≈ $7/month** and **1–2 hours
of maintenance per quarter**.

---

## Why not shared hosting

The legacy app ran on LAMP shared hosting. ASP.NET Core cannot.

Windows shared hosting with .NET support does exist and is cheap, but **do not
use it for this**. Those hosts recycle the application pool after ~20 minutes
idle, so the first sale after a quiet spell pays a cold start. That is precisely
the hang this rewrite exists to eliminate.

A VPS that fixes it costs about the same as what you pay now.

---

## What to buy

| Item | Monthly |
|---|---|
| VPS, 1–2 vCPU / 2 GB, Mumbai or Bangalore region | $5–6 |
| Backblaze B2 for backups (~1 GB) | < $0.50 |
| Domain, amortised | ~$1 |
| TLS (Caddy, Let's Encrypt) | free |
| **Total** | **≈ $7** |

Vultr, DigitalOcean and Linode all have Indian regions at this price. Hostinger's
India VPS is around ₹400–500.

Skip managed database and read replicas. At ~240 sales a day, one box with
tested restores and an offline-capable client is the correct risk posture.

---

## Build

On your machine, not the server:

```bash
cd src/web && npm ci && npm run build     # emits into ../Waterhouse.Api/wwwroot
cd ../Waterhouse.Api
dotnet publish -c Release -r linux-x64 --self-contained true -o ../../publish
```

Self-contained means **no .NET runtime to install or patch on the server**. That
is the single biggest cut to ongoing maintenance. `PublishReadyToRun` is already
set in the csproj, giving a ~50 ms start so a restart never lands on a customer.

---

## Server setup

```bash
sudo useradd --system --home /opt/waterhouse --shell /usr/sbin/nologin waterhouse
sudo mkdir -p /opt/waterhouse /var/lib/waterhouse
sudo chown -R waterhouse:waterhouse /opt/waterhouse /var/lib/waterhouse
```

Copy `publish/` to `/opt/waterhouse/` and the migrated database to
`/var/lib/waterhouse/waterhouse.db`.

### systemd — `/etc/systemd/system/waterhouse.service`

```ini
[Unit]
Description=Waterhouse POS
After=network.target

[Service]
Type=notify
User=waterhouse
WorkingDirectory=/opt/waterhouse
ExecStart=/opt/waterhouse/Waterhouse.Api
Restart=always
RestartSec=2

Environment=ASPNETCORE_ENVIRONMENT=Production
Environment=ASPNETCORE_URLS=http://127.0.0.1:5080
Environment=Database__Path=/var/lib/waterhouse/waterhouse.db
Environment=Business__TimeZone=+05:30

# Hardening. The legacy deployment served the app from the web root with .env
# and 21 MB of production SQL dumps inside it.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/waterhouse

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now waterhouse
```

`Restart=always` with no idle timeout is what guarantees no cold start.

### Caddy — `/etc/caddy/Caddyfile`

```
waterhouse.example.com {
    encode gzip zstd
    reverse_proxy 127.0.0.1:5080
}
```

That is the whole TLS story. Certificates issue and renew automatically.

---

## Backups

SQLite is one file, which makes this simple — but a plain `cp` of a live
database can capture a torn page. Use one of these.

### Litestream (recommended)

Continuous replication with point-in-time recovery. One binary, one service.

`/etc/litestream.yml`:

```yaml
dbs:
  - path: /var/lib/waterhouse/waterhouse.db
    replicas:
      - type: s3
        endpoint: s3.us-west-002.backblazeb2.com
        bucket: waterhouse-backups
        path: main
        retention: 720h
```

```bash
sudo systemctl enable --now litestream
```

Restore: `litestream restore -o /var/lib/waterhouse/waterhouse.db s3://waterhouse-backups/main`

### Nightly snapshot (simpler)

```bash
#!/usr/bin/env bash
set -euo pipefail
DEST=/var/backups/waterhouse
mkdir -p "$DEST"
# .backup uses SQLite's online backup API - safe while the till is selling.
sqlite3 /var/lib/waterhouse/waterhouse.db ".backup '$DEST/waterhouse-$(date +%F).db'"
find "$DEST" -name 'waterhouse-*.db' -mtime +30 -delete
rclone copy "$DEST" b2:waterhouse-backups
```

The Admin screen also offers a manual snapshot download, which uses the same
online backup API. That is a convenience, not a strategy.

### Restore drill

```bash
sudo systemctl stop waterhouse
sudo cp /path/to/snapshot.db /var/lib/waterhouse/waterhouse.db
sudo rm -f /var/lib/waterhouse/waterhouse.db-wal /var/lib/waterhouse/waterhouse.db-shm
sudo chown waterhouse:waterhouse /var/lib/waterhouse/waterhouse.db
sudo systemctl start waterhouse
```

**Do this on a copy once a quarter.** An untested backup is not a backup, and it
is the one maintenance task that cannot be automated away.

---

## First start

With no account able to sign in, an administrator is created and its password
printed **once**:

```bash
sudo journalctl -u waterhouse | grep -A3 'administrator was created'
```

Sign in and change it immediately. To set it explicitly instead, provide
`Seed__AdminPassword` as an environment variable on first start only, then
remove it.

**Never commit secrets.** The legacy repository has a live MySQL password and a
Gmail app password in `.env` in its git history — rotate both regardless of what
you do with this rewrite.

---

## Updating

```bash
# build locally, then
rsync -a --delete publish/ user@server:/tmp/waterhouse-new/
ssh user@server 'sudo systemctl stop waterhouse \
  && sudo rsync -a --delete /tmp/waterhouse-new/ /opt/waterhouse/ \
  && sudo chown -R waterhouse:waterhouse /opt/waterhouse \
  && sudo systemctl start waterhouse'
```

Migrations run automatically at startup, inside a transaction, and are
checksum-verified. A failed migration leaves the database untouched and the
service refuses to start rather than serving a mismatched schema.

Downtime is a couple of seconds — and because the till queues sales locally, the
counter does not notice.

---

## Deliberately not included

Each of these is something that breaks at 2 a.m., and none earn their place at
80 sales a day:

- **Docker** — an image, a registry, a daemon to patch, a layer to debug through
- **nginx** — Caddy already terminates TLS; do not run two web servers
- **Redis** — the working set is 30 KB and it lives in the browser
- **A message queue** — the IndexedDB outbox is the queue, on the right side of
  the network
- **Kubernetes, load balancers, read replicas** — no

---

## Ongoing maintenance

| Task | Frequency | Effort |
|---|---|---|
| OS security updates | automatic (`unattended-upgrades`) | none |
| .NET patches | quarterly, rebuild + redeploy | 15 min |
| TLS renewal | automatic (Caddy) | none |
| Database maintenance | none — it is a file | none |
| **Restore drill** | **quarterly** | **30 min** |

Roughly **1–2 hours a quarter**, most of it the restore drill.

The place cost quietly accumulates is npm dependency churn in `src/web`. Keep
direct dependencies under about 15 and refuse anything with a fast-moving major
version; that discipline is worth more than any infrastructure choice here.
