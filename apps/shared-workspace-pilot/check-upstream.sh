#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh
ref="${1:?Pass the exact reviewed upstream commit}"
[[ "$ref" =~ ^[0-9a-f]{40}$ ]] || exit 2
mkdir -p .local/upstream
git -C ../.. archive "$ref" packages/db/prisma | tar -x -C .local/upstream
config=../../packages/db/pilot-upgrade.config.ts
test ! -e "$config" || { echo 'Temporary configuration already exists'; exit 2; }
trap 'rm -f "$config"' EXIT
cat > "$config" <<'CONFIG'
import { defineConfig } from 'prisma/config';
export default defineConfig({
  schema:'../../apps/shared-workspace-pilot/.local/upstream/packages/db/prisma/schema.prisma',
  migrations:{path:'../../apps/shared-workspace-pilot/.local/upstream/packages/db/prisma/migrations'},
  datasource:{url:'postgresql://postgres:pilot-local-only@127.0.0.1:15439/rakazo_shared_pilot'},
});
CONFIG
pnpm --dir ../../packages/db exec prisma migrate deploy --config pilot-upgrade.config.ts > .local/upstream-migrations.log 2>&1
npm test > .local/upstream-tests.tap 2>&1
tail -12 .local/upstream-tests.tap
