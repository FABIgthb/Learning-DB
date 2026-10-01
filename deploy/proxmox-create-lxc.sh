#!/usr/bin/env bash
# Run ON THE PROXMOX HOST as root. Creates a Debian 12 LXC and installs learn.fabi-pm.xyz inside it.
#   curl -fsSL <raw-url>/deploy/proxmox-create-lxc.sh -o create.sh && bash create.sh
set -euo pipefail

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
HOSTNAME="${HOSTNAME_CT:-learn}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-4096}"          # MB
SWAP="${SWAP:-1024}"
DISK="${DISK:-16}"                # GB
ROOTFS_STORAGE="${ROOTFS_STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
REPO_URL="${REPO_URL:-https://github.com/FABIgthb/Learning-DB.git}"
BRANCH="${BRANCH:-main}"

echo "==> Finding latest Debian 12 template"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || { echo "No Debian 12 template found"; exit 1; }
pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE" || pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"

echo "==> Creating CT $CTID ($HOSTNAME): ${CORES} cores, ${MEMORY} MB RAM, ${DISK} GB disk"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME" --cores "$CORES" --memory "$MEMORY" --swap "$SWAP" \
  --rootfs "$ROOTFS_STORAGE:$DISK" --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 --features nesting=1 --onboot 1 --start 1

echo "==> Waiting for network"
for _ in $(seq 1 30); do pct exec "$CTID" -- ping -c1 -W1 deb.debian.org >/dev/null 2>&1 && break; sleep 2; done

pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq git curl ca-certificates >/dev/null"
pct exec "$CTID" -- git clone --branch "$BRANCH" "$REPO_URL" /opt/learn
pct exec "$CTID" -- bash /opt/learn/deploy/setup.sh

echo
echo "Done. CT $CTID is serving on 127.0.0.1:3000 inside the container."
echo "Next: connect the Cloudflare Tunnel — see deploy/README.md (step 3)."
