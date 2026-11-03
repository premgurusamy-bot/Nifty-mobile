#!/usr/bin/env bash
# Nifty Trader server — one-command install for Ubuntu / Debian (systemd).
#
#   curl -fsSL https://raw.githubusercontent.com/premgurusamy-bot/Nifty-mobile/ccr-f60cf00a-vmzuuf/server/setup.sh -o setup.sh
#   sudo bash setup.sh
#
# Re-run the same command any time to update to the latest code (your settings are kept).
#
# What it does: installs Node 22 if needed, puts the app in /opt/nifty-trader, asks for
# your Dhan client id + access token (typed here, stored only in /opt/nifty-trader/server/.env,
# readable by the service user only), generates the app access key, checks the
# credentials against Dhan, and runs the server as a systemd service that restarts on
# failure and on reboot. Optional: HTTPS via Caddy if you have a domain name.
set -euo pipefail

REPO="https://github.com/premgurusamy-bot/Nifty-mobile.git"
BRANCH="${NIFTY_BRANCH:-ccr-f60cf00a-vmzuuf}"
DIR="/opt/nifty-trader"
SVC_USER="nifty"
SERVICE="nifty-trader"
ENV_FILE="$DIR/server/.env"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo:  sudo bash setup.sh"
command -v systemctl >/dev/null || die "systemd is required (Ubuntu/Debian server)."
command -v apt-get >/dev/null || die "This script supports Ubuntu/Debian (apt). On other systems follow README → Server setup."

# Prompts read from the terminal even when the script is piped.
exec 3</dev/tty || die "Run this in an interactive terminal (ssh session)."
ask() { local p="$1" d="${2:-}" a; read -r -u 3 -p "$p${d:+ [$d]}: " a; echo "${a:-$d}"; }
ask_secret() { local p="$1" a; read -r -s -u 3 -p "$p: " a; echo >&2; echo "$a"; }
yes_no() { local a; a=$(ask "$1 (y/N)" "N"); [[ "$a" =~ ^[Yy] ]]; }

# ---------------------------------------------------------------- packages
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl >/dev/null

node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'
}
if ! node_ok; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node_ok || die "Node.js >= 22.18 is required (found $(node -v 2>/dev/null || echo none))."
NODE_BIN="$(command -v node)"
echo "Node $(node -v)"

# ---------------------------------------------------------------- code
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin "$SVC_USER"
if [[ -d "$DIR/.git" ]]; then
  say "Updating code in $DIR"
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  say "Downloading code to $DIR"
  git clone -q --depth 50 -b "$BRANCH" "$REPO" "$DIR"
fi
mkdir -p "$DIR/server/data"
chown -R "$SVC_USER:$SVC_USER" "$DIR"
git config --system --add safe.directory "$DIR" 2>/dev/null || true

# ---------------------------------------------------------------- configuration
DOMAIN=""
PORT=8787
if [[ -f "$ENV_FILE" ]] && ! yes_no "Existing settings found. Re-enter Dhan credentials and settings?"; then
  say "Keeping existing settings"
  PORT=$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || true); PORT=${PORT:-8787}
  DOMAIN=$(grep -E '^# DOMAIN=' "$ENV_FILE" | cut -d= -f2 || true)
else
  say "Dhan credentials (web.dhan.co → Profile → DhanHQ Trading APIs)"
  CLIENT_ID=$(ask "Dhan client id")
  [[ -n "$CLIENT_ID" ]] || die "Client id is required."
  TOKEN=$(ask_secret "Dhan access token (input hidden)")
  [[ ${#TOKEN} -ge 20 ]] || die "That does not look like a Dhan access token."

  say "Orders"
  echo "The engine only signals (like the Excel workbook). With live orders ON, the app's"
  echo "order ticket can also place REAL orders on your Dhan account (it asks to confirm each one)."
  LIVE=false; yes_no "Enable live orders from the app?" && LIVE=true
  MAXV=$(ask "Max value per order in Rs (0 = no limit)" "200000")

  say "Alerts (optional)"
  TG_TOKEN=$(ask "Telegram bot token (Enter to skip)" "")
  TG_CHAT=""; [[ -n "$TG_TOKEN" ]] && TG_CHAT=$(ask "Telegram chat id" "")

  say "HTTPS (optional)"
  echo "If a domain name points at this server's IP, Caddy can serve the app over HTTPS."
  DOMAIN=$(ask "Domain name (Enter to skip and use http://IP:$PORT)" "")

  KEY=$(openssl rand -hex 24)
  HOST=0.0.0.0; [[ -n "$DOMAIN" ]] && HOST=127.0.0.1
  umask 077
  cat >"$ENV_FILE" <<EOF
# Written by server/setup.sh on $(date -u +%Y-%m-%dT%H:%MZ). Keep this file private.
DHAN_CLIENT_ID=$CLIENT_ID
DHAN_ACCESS_TOKEN=$TOKEN
APP_API_KEY=$KEY
PORT=$PORT
HOST=$HOST
LIVE_ORDERS=$LIVE
MAX_ORDER_VALUE=$MAXV
TELEGRAM_BOT_TOKEN=$TG_TOKEN
TELEGRAM_CHAT_ID=$TG_CHAT
DATA_DIR=server/data
TOKEN_AUTO_RENEW=true
# DOMAIN=$DOMAIN
EOF
  chown "$SVC_USER:$SVC_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# ---------------------------------------------------------------- verify Dhan
say "Checking your Dhan credentials against the live API"
if ! (cd "$DIR" && runuser -u "$SVC_USER" -- "$NODE_BIN" --disable-warning=MODULE_TYPELESS_PACKAGE_JSON server/cli.ts check); then
  warn "Dhan checks failed. The server will still be installed; fix the token with:"
  warn "  cd $DIR && sudo -u $SVC_USER node server/cli.ts set-token && sudo systemctl restart $SERVICE"
fi

# ---------------------------------------------------------------- service
say "Installing the $SERVICE service"
cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Nifty Trader server (Dhan bridge + option-buying engine)
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
WorkingDirectory=$DIR
ExecStart=$NODE_BIN --disable-warning=MODULE_TYPELESS_PACKAGE_JSON server/index.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=TZ=Asia/Kolkata
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DIR/server

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"

# ---------------------------------------------------------------- HTTPS / firewall
if [[ -n "$DOMAIN" ]]; then
  say "Setting up HTTPS for $DOMAIN with Caddy"
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  cat >/etc/caddy/Caddyfile <<EOF
$DOMAIN {
  reverse_proxy 127.0.0.1:$PORT
}
EOF
  systemctl reload caddy || systemctl restart caddy
fi

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  if [[ -n "$DOMAIN" ]]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; else ufw allow "$PORT"/tcp >/dev/null; fi
  echo "ufw: opened $([[ -n "$DOMAIN" ]] && echo '80, 443' || echo "$PORT")"
fi

# ---------------------------------------------------------------- done
say "Waiting for the server to start"
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
curl -fs "http://127.0.0.1:$PORT/health" >/dev/null || { journalctl -u $SERVICE -n 30 --no-pager; die "Server did not start — logs above."; }

KEY=$(grep -E '^APP_API_KEY=' "$ENV_FILE" | cut -d= -f2)
PUBLIC_IP=$(curl -fs -4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
URL="http://$PUBLIC_IP:$PORT"; [[ -n "$DOMAIN" ]] && URL="https://$DOMAIN"
STATUS=$(curl -fs -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/status" || echo '{}')

cat <<EOF

────────────────────────────────────────────────────────────
 Nifty Trader server is running.

 In the app: ⚙ Settings → Dhan server
   Server URL:  $URL
   Access key:  $KEY

 Status: $STATUS
────────────────────────────────────────────────────────────
 Next:
  • Cloud firewall / security group: allow inbound TCP $([[ -n "$DOMAIN" ]] && echo '80 and 443' || echo "$PORT") to this server.
  • Live orders need this server's static IP ($PUBLIC_IP) whitelisted at
    web.dhan.co → Profile → DhanHQ Trading APIs.
  • Logs:          journalctl -u $SERVICE -f
  • Check Dhan:    cd $DIR && sudo -u $SVC_USER node server/cli.ts check
  • New token:     cd $DIR && sudo -u $SVC_USER node server/cli.ts set-token && sudo systemctl restart $SERVICE
  • Update code:   sudo bash setup.sh   (settings are kept)
  • Import Excel journal/IV history (stop the server first):
                   sudo systemctl stop $SERVICE
                   sudo -u $SVC_USER python3 $DIR/scripts/import_workbook.py /path/to/workbook.xlsm $DIR/server/data/engine.json
                   sudo systemctl start $SERVICE
EOF
