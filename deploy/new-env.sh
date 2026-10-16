#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Write deploy/.env for deploy/docker-compose.yml, with every secret freshly
# generated. Needs only a POSIX shell — no Node, no checkout tooling — so it runs
# on the server itself.
#
#   sh deploy/new-env.sh https://mixos.example.com you@example.com
#
# The first argument is the public URL people will sign in at. The second, if
# given, becomes the first admin account; its generated password is printed
# once, here, and nowhere else.
#
# It refuses to overwrite an existing deploy/.env. Three of the keys it writes
# encrypt data at rest, so replacing them on a running install would make every
# stored credential and setting unreadable. To rotate one key, see
# src/lib/env/keys.ts for what it costs, then edit the file by hand.

set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="$DIR/.env"
URL=${1:-}
EMAIL=${2:-}

if [ -z "$URL" ]; then
  echo "usage: sh deploy/new-env.sh <public URL> [admin email]" >&2
  echo "  e.g. sh deploy/new-env.sh https://mixos.example.com you@example.com" >&2
  exit 2
fi
case "$URL" in
  http://* | https://*) ;;
  *)
    echo "The public URL needs its scheme: https://$URL" >&2
    exit 2
    ;;
esac
if [ -e "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists; not overwriting it." >&2
  echo "Its keys decrypt data already stored. Edit it by hand to change a value." >&2
  exit 1
fi

# N random bytes as hex. openssl where there is one; /dev/urandom otherwise.
hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

PASSWORD=""
if [ -n "$EMAIL" ]; then
  PASSWORD=$(hex 12)
fi

umask 077
cat > "$ENV_FILE" <<EOF
# Written by deploy/new-env.sh on $(date -u '+%Y-%m-%d'). Read by
# deploy/docker-compose.yml. See deploy/.env.example for what each value is.
# BACK THIS FILE UP: the keys below decrypt data stored in the database.

MIXOS_URL=$URL

POSTGRES_PASSWORD=$(hex 24)

AUTH_SECRET=$(hex 32)
CONNECTOR_ENCRYPTION_KEY=$(hex 32)
USER_OAUTH_ENCRYPTION_KEY=$(hex 32)
APP_SETTINGS_ENCRYPTION_KEY=$(hex 32)
MCP_TOKEN_KEY=$(hex 32)
APP_API_KEY_SECRET=$(hex 32)
APP_UNLOCK_SECRET=$(hex 32)
CRON_SECRET=$(hex 32)

# Created on the first deploy if no account has this email; never changed after.
INITIAL_ADMIN_EMAIL=$EMAIL
INITIAL_ADMIN_PASSWORD=$PASSWORD
EOF

echo "Wrote $ENV_FILE"
if [ -n "$EMAIL" ]; then
  echo
  echo "First admin:  $EMAIL"
  echo "Password:     $PASSWORD"
  echo "(Shown once. Change it from the account page after you sign in.)"
fi
