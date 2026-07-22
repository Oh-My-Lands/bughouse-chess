# Deployment

The analysis viewer runs as a Next.js standalone server under systemd, behind
Caddy (which terminates HTTPS via Let's Encrypt) at **analysis.josephw.me**.
The build happens locally and only the self-contained bundle is shipped, so the
server needs the Node runtime but no build toolchain and no `npm install`.

Target box: Hetzner CX23, `root@138.199.195.186`, Fedora. Same box the explorer
runs on; this app binds `127.0.0.1:3100` (the explorer uses `:8000`).

## Routine deploy

From the repo root:

```sh
./deploy.sh                                # build locally, sync bundle, restart
ANALYSIS_SERVER=root@1.2.3.4 ./deploy.sh   # target a different server
```

`NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_ENGINE_ENDPOINT` are baked at build time
inside `deploy.sh` — they cannot be changed on the server afterward.

## First-time server setup

On the box (Fedora, examples use `dnf`):

1. **Node runtime** (Next 16 needs Node ≥ 20.9; install a current LTS)
   ```sh
   dnf -y install nodejs   # verify: node -v  (must be >= 20.9)
   ```

2. **User & directories**
   ```sh
   useradd --system --create-home --home-dir /opt/analysis --shell /usr/sbin/nologin analysis
   mkdir -p /opt/analysis/app
   ```

3. **RunPod credentials** — server-side only, never in the repo or the client
   bundle. Create `/opt/analysis/env`:
   ```sh
   cat > /opt/analysis/env <<'EOF'
   RUNPOD_ENDPOINT_ID=<your endpoint id>
   RUNPOD_API_KEY=<your api key>
   EOF
   chmod 600 /opt/analysis/env
   chown root:root /opt/analysis/env
   ```

4. **First bundle push** — from your machine, run `./deploy.sh`. It builds and
   rsyncs to `/opt/analysis/app`. (The service won't exist yet; the restart step
   will fail harmlessly on the very first run — continue to step 5, then re-run
   `./deploy.sh` or `systemctl start analysis-viewer`.)

5. **Service**
   ```sh
   cp deploy/analysis-viewer.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now analysis-viewer
   systemctl is-active analysis-viewer          # -> active
   curl -sS localhost:3100 | head               # -> HTML
   ```

6. **Reverse proxy** — append the vhost to the existing Caddyfile (the explorer
   block stays; Caddy serves multiple sites from one file):
   ```sh
   cat deploy/Caddyfile >> /etc/caddy/Caddyfile
   systemctl reload caddy
   ```

7. **DNS (Porkbun)** — add records for `analysis`:
   - `A`    `analysis` → `138.199.195.186`
   - `AAAA` `analysis` → `2a01:4f8:c2c:dc81::1`

   Caddy obtains the TLS cert automatically once the name resolves.

## Verify the engine

The viewer proxies to RunPod server-side. To confirm the endpoint/key on the
box are current, the app also ships a check script — from the repo on your
machine, `npm run check:engine` (it reads your local `.env.local`). On the
server the same is answered by a healthy request through the running app.

## Retiring the explorer

This app is meant to replace the explorer. Do it reversibly — take it off the
web but leave its data on disk:

```sh
systemctl disable --now bughouse             # stop + don't restart on boot
# remove the explorer vhost from /etc/caddy/Caddyfile (the explorer.josephw.me
# block), then:
systemctl reload caddy
```

`/opt/bughouse` and the ~8.9 GB `games.db` are left untouched, so the explorer
can be brought back with `systemctl enable --now bughouse` + restoring its
vhost. Delete `/opt/bughouse` only once you're sure you want the disk back.

## Ops

```sh
systemctl restart analysis-viewer            # restart
journalctl -u analysis-viewer -f             # app logs
journalctl -u caddy -f                       # proxy / TLS logs
```
