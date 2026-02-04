#!/usr/bin/env bash
set -euxo pipefail

# Configuration
TMPDIR="${RUNNER_TEMP:-/tmp}"
MONGODB_CONTAINER_NAME="mongo-local"
MONGODB_PORT=27017
MONGODB_LOG_FILE="$TMPDIR/mongodb.log"

# Pull latest MongoDB image
docker pull mongo:latest

# Remove any existing MongoDB container for idempotence
docker rm -f "$MONGODB_CONTAINER_NAME" || true

# Start MongoDB container with replica set configuration
docker run --name "$MONGODB_CONTAINER_NAME" -p "$MONGODB_PORT":"$MONGODB_PORT" mongo:latest --replSet rs0 2>&1 > "$MONGODB_LOG_FILE" &

# Poll until MongoDB is ready
is_ready=false
for i in {1..30}; do
  if docker exec "$MONGODB_CONTAINER_NAME" mongosh --eval 'db.adminCommand({ ping: 1 })'; then
    echo "MongoDB is ready!"
    is_ready=true
    break
  else
    echo "Waiting for MongoDB to be ready..."
    sleep 2
  fi
done
if [ "$is_ready" = false ]; then
  echo "MongoDB did not become ready in time."
  exit 1
fi

# Initialize the replica set
docker exec "$MONGODB_CONTAINER_NAME" mongosh --eval "rs.initiate()"

# Done
echo "MongoDB started. See logs at $MONGODB_LOG_FILE"
