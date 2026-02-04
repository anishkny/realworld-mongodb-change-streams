#!/usr/bin/env bash
set -euxo pipefail

# Default to 1 shard for backward compatibility
SHARD_COUNT=${SHARD_COUNT:-1}

if [ "$SHARD_COUNT" -eq 1 ]; then
  # Single shard mode (original behavior)
  npm start > >(tee node_modules/app.log) 2>&1 &
  APP_PID=$!
  
  cleanup() {
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill "$APP_PID"
    fi
  }
  
  trap cleanup ERR
  
  # Poll app.log for "Change streams set up and running."
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
else
  # Multi-shard mode
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
      if grep -q "Change streams set up and running. (Shard $i/$SHARD_COUNT)" "node_modules/app-shard-$i.log" 2>/dev/null; then
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
fi

