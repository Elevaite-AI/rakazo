# Synthetic, loopback-only credentials. Never source a deployment .env here.
export PILOT_ADMIN_DATABASE_URL='postgresql://postgres:pilot-local-only@127.0.0.1:15439/rakazo_shared_pilot'
export PILOT_DATABASE_URL='postgresql://shared_pilot_app:pilot-runtime-only@127.0.0.1:15439/rakazo_shared_pilot'
