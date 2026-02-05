#!/usr/bin/env bash
set -euo pipefail
if [ -n "${CI:-}" ]; then set -x; fi

SHARD_COUNT=4
SHARD_PIDS=()

cleanup() {
  for pid in "${SHARD_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
    fi
  done
}
trap cleanup ERR EXIT

# Start all shards
for i in $(seq 0 $((SHARD_COUNT - 1))); do
  SHARD_INDEX=$i SHARD_COUNT=$SHARD_COUNT npm start > >(tee "node_modules/app-shard-$i.log") 2>&1 &
  SHARD_PIDS+=($!)
  echo "Started shard $i with PID ${SHARD_PIDS[$i]}"
done

# Wait for all shards to be ready
is_ready=false
for attempt in {1..10}; do
  ready_count=0
  for i in $(seq 0 $((SHARD_COUNT - 1))); do
    if grep -q "__READY__SHARD__${i}_OF_${SHARD_COUNT}__" "node_modules/app-shard-$i.log" 2>/dev/null; then
      ((ready_count++)) || true
    fi
  done
  
  if [ "$ready_count" -eq "$SHARD_COUNT" ]; then
    echo "All $SHARD_COUNT shards are ready!"
    is_ready=true
    break
  else
    echo "Waiting for shards to be ready... ($ready_count/$SHARD_COUNT ready)"
    sleep 1
  fi
done

if [ "$is_ready" = false ]; then
  echo "Not all shards became ready in time."
  exit 1
fi

# Run tests
npm run test:only

# Cleanup
cleanup

