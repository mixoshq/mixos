# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Entrypoint for the app-dev container: runs the dev server as the person who
# owns the checkout, whenever docker-up.ts says who that is.
#
# The dev server writes into the bind-mounted checkout — the generated
# registry, next-env.d.ts — and the container runs as root. On macOS that is
# invisible: Docker Desktop maps every write back to the folder's owner. On
# Linux and in WSL, ownership crosses the mount unchanged, so each of those
# files would land owned by root and the next `npm run registry` on the host
# fails with EACCES inside the person's own repository. docker-up.ts passes
# their uid and gid in (MIXOS_UID / MIXOS_GID — see checkoutOwner() in
# scripts/host-platform.ts) and this drops to them before starting the server.
#
# With MIXOS_UID unset — macOS, or anyone running compose by hand — this is a
# plain exec, and the container runs as root exactly as it always has.

set -eu

uid="${MIXOS_UID:-}"
gid="${MIXOS_GID:-}"

if [ -z "$uid" ] || [ "$uid" = 0 ]; then
  exec "$@"
fi
gid="${gid:-$uid}"

# Hand back anything an earlier boot wrote as root, before this existed —
# otherwise the dev server, now running as them, could not overwrite it. A
# root-owned file in someone's checkout can only have come from a container.
# -xdev keeps find on the bind mount itself: the node_modules and .next volumes
# mounted beneath /app are other filesystems. .git is skipped because nothing
# here writes to it, and it is the largest tree in the checkout.
find /app -xdev -path /app/.git -prune -o -user 0 -exec chown "$uid:$gid" {} +

# The build-output volume is written on every compile and was created as root.
# Only what is not already theirs is touched, which after the first boot is
# nothing. node_modules stays root's: it is read, never written, at runtime.
find /app/.next ! -user "$uid" -exec chown "$uid:$gid" {} +

# An arbitrary uid has no passwd entry, so HOME would stay /root, which that
# user cannot write — and npm, tsx and Next's telemetry all want a home.
export HOME=/tmp/mixos-home
mkdir -p "$HOME"
chown "$uid:$gid" "$HOME"

exec setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$@"
