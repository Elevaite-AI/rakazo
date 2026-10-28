#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh
if docker container inspect rakazo-shared-pilot-db >/dev/null 2>&1; then
  test "$(docker inspect -f '{{index .Config.Labels "purpose"}}' rakazo-shared-pilot-db)" = isolated-shared-workspace-pilot
else
  docker run -d --name rakazo-shared-pilot-db --label purpose=isolated-shared-workspace-pilot \
    --memory=512m --cpus=1 -e POSTGRES_DB=rakazo_shared_pilot -e POSTGRES_PASSWORD=pilot-local-only \
    -p 127.0.0.1:15439:5432 postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94
fi
for attempt in {1..30}; do
  if docker exec rakazo-shared-pilot-db pg_isready -U postgres -d rakazo_shared_pilot >/dev/null; then break; fi
  sleep 1
done
npm ci --ignore-scripts
# Root workspace dependencies must already be installed with the pinned pnpm lockfile.
DATABASE_MIGRATION_URL="$PILOT_ADMIN_DATABASE_URL" pnpm --dir ../../packages/db exec prisma migrate deploy
npm run seed
npm test
