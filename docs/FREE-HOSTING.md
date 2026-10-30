# Hosting a free test instance

For handing someone a URL to click around in. **Not** for production — see
[`DEPLOYMENT.md`](DEPLOYMENT.md) for that.

The thing that makes this easy: **you don't need the data.** The app creates its
own schema and seeds itself on first start, so a host with no persistent disk is
fine. If the container restarts and wipes the database, it rebuilds itself.

> Free tiers change often, and the specifics below were accurate when written.
> Check current terms before relying on any of them. The durable part is the
> `Dockerfile` — it runs anywhere that takes a container.

---

## What was added to make this work

Three things, none of which the app had before:

| | Why |
|---|---|
| `Dockerfile` | Multi-stage: builds the UI and API, ships only the runtime. |
| `PORT` support in `Program.cs` | Container hosts assign a port at runtime and pass it as `PORT`. ASP.NET Core only reads `ASPNETCORE_URLS`, so without this bridge the health check never succeeds and the deploy fails with nothing obviously wrong. |
| `Seed:Demo` flag | A genuinely empty install cannot be tested — no customers means the POS has nothing to sell to. This creates 8 sample customers with agreed rates and 500 of each cap colour. **Off by default.** |

---

## Option 1 — Render (easiest)

Free web service tier, no card for the free plan, builds straight from a Git
repository using the `Dockerfile`.

1. Push this repository to GitHub.
2. Render → **New → Web Service** → connect the repo.
3. Runtime **Docker**. Render detects the `Dockerfile` and injects `PORT`.
4. Add environment variables:

   | Key | Value |
   |---|---|
   | `Seed__Demo` | `true` |
   | `Seed__AdminPassword` | something you'll share with the tester |

5. Deploy. You get `https://<name>.onrender.com`.

**The catch:** free services spin down after ~15 minutes of inactivity, and the
next request takes roughly 30–60 seconds to wake. Tell your tester, or they'll
think it's broken. Free services also have no persistent disk, so the database
resets on each restart — which for a test instance is fine, and occasionally
useful.

---

## Option 2 — Azure App Service, F1 Free

First-party for .NET, genuinely free, and keeps its files between restarts.

```bash
az webapp up --name waterhouse-demo --sku F1 --runtime "DOTNET:10"
az webapp config appsettings set --name waterhouse-demo \
  --settings Seed__Demo=true Seed__AdminPassword=<pick-one> Database__Path=/home/data/waterhouse.db
```

`/home` is the persisted path on App Service — put the database there or it is
lost on every restart.

**The catch:** F1 is capped at 60 CPU-minutes per day. Ample for someone
clicking around; not for a load test.

---

## Option 3 — Fly.io

Better performance and real persistent volumes, but needs a card on file even
within the free allowance.

```bash
fly launch --no-deploy          # detects the Dockerfile
fly volume create data --size 1
fly secrets set Seed__Demo=true Seed__AdminPassword=<pick-one>
fly deploy
```

Mount the volume at `/data` — the `Dockerfile` already points
`Database__Path` there.

---

## Option 4 — Oracle Cloud Always Free

By far the most capable: 4 ARM cores and 24 GB RAM, free indefinitely, with
Mumbai and Hyderabad regions. It is a full VM, so follow
[`DEPLOYMENT.md`](DEPLOYMENT.md) rather than this page.

**The catch:** card required for identity verification, ARM capacity can be hard
to get in popular regions, and there is no SLA — accounts have been reclaimed
for inactivity. Fine for a long-lived demo, not for anything you depend on.

---

## Environment variables

| Key | Needed | Notes |
|---|---|---|
| `PORT` | host sets it | Bridged to Kestrel automatically. |
| `Seed__Demo` | `true` for a demo | **Never set this against real data.** |
| `Seed__AdminPassword` | recommended | Otherwise a random one is generated and printed once to the log. |
| `Database__Path` | if you have a disk | Defaults to `/data/waterhouse.db` in the image. |
| `Business__TimeZone` | already set | `+05:30`. See the note below. |

### A note on `Business__TimeZone`

Set it to a **fixed offset** (`+05:30`), not a name (`Asia/Kolkata`).

The project builds with `InvariantGlobalization=true`, which strips the ICU data
.NET uses to resolve named timezone ids. Under that setting a named id throws,
the app falls back to UTC, and every daily report then rolls over at UTC
midnight — 5:30am local. Sales taken before 5:30am would be counted on the
previous day's sheet, quietly.

A fixed offset is not a workaround, it is more correct here: India has never
observed daylight saving, so `+05:30` is exact all year and needs no timezone
database. A region that *does* observe DST must use a named id and build with
globalization enabled.

---

## Handing it over

Send the tester:

- the URL
- the username (`admin`) and the password you set
- that the first load may take ~30–60s if the host sleeps idle services
- that it is a demo with sample data, and anything they enter may be wiped

### A five-minute tour for them

1. **Sell → Local / walk-in** → tap a rate → type a quantity → **Save**. Watch
   the cap count drop and the dispensing slip appear.
2. **Sell → Registered customer** → search "Ravi" → their agreed rate loads with
   no delay. Enter a part payment and watch the balance.
3. **Stock → Caps** → issue more caps, then go back to **Sell** — the new count
   appears within a few seconds.
4. **Sales** → filter by customer, date, payment method. Edit a sale as admin.
5. **Dashboard** → registered-vs-local split, payments by method.
6. **Turn off their wifi** and keep selling. Sales queue locally and sync when
   it returns — this is the part worth showing.

---

## Costs nothing, proves nothing

A free instance tells you the app works and looks right. It does **not** tell
you anything about production performance: free tiers are heavily throttled,
usually have no persistent disk, and often sleep. Do not benchmark on one.
