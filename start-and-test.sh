#!/usr/bin/env bash
set -euxo pipefail

npm start > >(tee node_modules/app.log) 2>&1 &
APP_PID=$!

cleanup() {
  if kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID"
  fi
}

trap cleanup ERR

# Poll app.log for "Change streams set up and running."
# for up to 10 attempts, waiting 1 seconds between attempts
is_ready=false
for i in {1..10}; do
  if grep -q "Change streams set up and running." node_modules/app.log; then
    echo "App is ready!"
    is_ready=true
    break
  else
    echo "Waiting for app to be ready..."
    sleep 1
  fi
done
if [ "$is_ready" = false ]; then
  echo "App did not become ready in time."
  exit 1
fi

# Run tests
npm run test:only

# Cleanup
cleanup
