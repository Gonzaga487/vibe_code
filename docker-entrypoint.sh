#!/bin/sh
set -eu

# Render/Railway bind-mounted disks can be owned by root. Prepare only the
# database directory, then drop privileges for the application process.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data
  exec gosu node "$@"
fi

exec "$@"
