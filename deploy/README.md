# Deploying on Proxmox

Result: one unprivileged Debian 12 LXC (2 cores, 4 GB RAM, 16 GB disk) running Postgres + the app on `127.0.0.1:3000`, published only through a Cloudflare Tunnel — no open ports.

## 1. Create the container (Proxmox host shell, as root)

```bash
curl -fsSL https://raw.githubusercontent.com/FABIgthb/Learning-DB/main/deploy/proxmox-create-lxc.sh -o create.sh
bash create.sh
```

Override defaults with env vars, e.g. `CTID=120 MEMORY=4096 ROOTFS_STORAGE=local-zfs bash create.sh`.
Private repo? Use `REPO_URL=https://<token>@github.com/FABIgthb/Learning-DB.git`.

## 2. Check it

```bash
pct exec <CTID> -- curl -s http://127.0.0.1:3000/api/health   # {"status":"ok","database":"up"}
```

## 3. Cloudflare Tunnel (inside the container: `pct enter <CTID>`)

```bash
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb && apt install -y ./cf.deb
cloudflared tunnel login                       # opens a URL — authorise fabi-pm.xyz
cloudflared tunnel create learn                # prints the TUNNEL_ID
cloudflared tunnel route dns learn learn.fabi-pm.xyz
mkdir -p /etc/cloudflared && cp ~/.cloudflared/*.json /etc/cloudflared/
cp /opt/learn/deploy/cloudflared-config.yml /etc/cloudflared/config.yml   # then fill in <TUNNEL_ID> twice
cloudflared service install && systemctl enable --now cloudflared
```

Or skip login: create the tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels), add public hostname `learn.fabi-pm.xyz → http://127.0.0.1:3000`, and run the `cloudflared service install <token>` command it shows.

## Updating

```bash
pct exec <CTID> -- bash /opt/learn/deploy/setup.sh
```
