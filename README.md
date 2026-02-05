# RealWorld MongoDB Change Streams

This repository demonstrates how to use MongoDB Change Streams to keep denormalized data in sync for a RealWorld-style backend.

It focuses only on the change stream worker, not on HTTP APIs, authentication, or frontend code.

## Quick start

```bash
npm install
./start-mongodb.sh
npm start &
npm run test:only
```

## What this demonstrates

A minimal but realistic pattern for MongoDB-backed applications that:

- Denormalize user data into articles and comments
- Maintain a global tag list
- Keep derived counters like favoritesCount correct
- Accept eventual consistency and repair it asynchronously
- Scale horizontally through sharding for high-throughput scenarios

All updates are driven by MongoDB change streams, not application code.

## Why Change Streams

MongoDB does not support triggers or webhooks that invoke serverless functions directly.

Change streams provide:

- Ordered, reliable change events
- Resume tokens for crash-safe processing
- Low-latency propagation
- A clean separation between writes and derived state

This mirrors how production systems implement background consistency workers.

## Collections involved

Source of truth:

- users
- articles
- comments
- favorites

Derived and denormalized:

- articles.author fields (username, bio, image)
- comments.author fields (username, bio, image)
- articles.favoritesCount
- tags (global tag list with article counts)

## Worker responsibilities

The change stream worker:

- Watches users & propagates profile changes to articles and comments
- Watches articles & maintains the global tag list and tag article counts
- Watches favorites & maintains articles.favoritesCount

There are no synchronous cross-collection updates and no multi-document transactions.

## Eventual consistency model

- Writes are fast and local
- Derived fields may be briefly stale
- A background worker converges state
- Reads rely on denormalized fields for performance

This is the tradeoff used by most high-scale MongoDB systems.

## Running the worker

The worker attaches to MongoDB and begins reacting to changes immediately once started.

### Single worker

```bash
npm start
```

### Running with sharding

For high-throughput scenarios, you can run multiple worker instances that partition the workload based on document IDs. Each shard processes a subset of changes, allowing for horizontal scaling.

#### How sharding works

The sharding mechanism uses a modulo-based distribution:

1. Each change event's document ID is hashed
2. The hash modulo `SHARD_COUNT` determines which shard handles that event
3. Each worker only processes events where `hash(documentKey._id) % SHARD_COUNT == SHARD_INDEX`

This ensures:
- Each document is processed by exactly one worker
- No coordination between workers is needed
- Load is distributed evenly across shards

#### Configuration

Set these environment variables to control sharding:

- `SHARD_COUNT` - Total number of shards (default: 1)
- `SHARD_INDEX` - This worker's shard number, from 0 to SHARD_COUNT-1 (default: 0)

#### Example: Running 4 shards

Start each shard in a separate terminal or process:

```bash
# Terminal 1 - Shard 0
SHARD_INDEX=0 SHARD_COUNT=4 npm start

# Terminal 2 - Shard 1
SHARD_INDEX=1 SHARD_COUNT=4 npm start

# Terminal 3 - Shard 2
SHARD_INDEX=2 SHARD_COUNT=4 npm start

# Terminal 4 - Shard 3
SHARD_INDEX=3 SHARD_COUNT=4 npm start
```

Each worker will display its shard configuration on startup:
```
Connected to MongoDB Atlas (Shard 0/4)
```

#### Example: Running shards with Docker Compose

You can also use Docker Compose or process managers to run multiple shards:

```yaml
services:
  worker-0:
    build: .
    environment:
      - MONGODB_URI=mongodb://mongo:27017/conduit?replicaSet=rs0
      - SHARD_INDEX=0
      - SHARD_COUNT=4
  worker-1:
    build: .
    environment:
      - MONGODB_URI=mongodb://mongo:27017/conduit?replicaSet=rs0
      - SHARD_INDEX=1
      - SHARD_COUNT=4
  worker-2:
    build: .
    environment:
      - MONGODB_URI=mongodb://mongo:27017/conduit?replicaSet=rs0
      - SHARD_INDEX=2
      - SHARD_COUNT=4
  worker-3:
    build: .
    environment:
      - MONGODB_URI=mongodb://mongo:27017/conduit?replicaSet=rs0
      - SHARD_INDEX=3
      - SHARD_COUNT=4
```

#### When to use sharding

Use multiple shards when:
- Change event volume exceeds what one worker can process
- You need higher throughput for propagating changes
- CPU or network becomes a bottleneck on a single worker
- You want redundancy (though each shard handles different documents)

For most applications, a single worker is sufficient. Consider sharding when processing thousands of changes per second.

## Testing

End-to-end tests use a real MongoDB instance with sharded workers:

```bash
npm test
```

This runs `start-and-test.sh`, which:
1. Starts 4 worker shards (SHARD_COUNT=4, SHARD_INDEX=0-3)
2. Waits for all shards to be ready
3. Runs the test suite against all shards
4. Cleans up all worker processes

Tests validate that:

- Updating users propagates changes to articles and comments
- Updating article tags updates the global tag list
- Adding or removing favorites updates favoritesCount
- Rapid or conflicting updates converge correctly
- Multiple shards correctly partition and process changes without conflicts

## What this is not

- Not a full RealWorld API implementation
- Not a recommendation to denormalize everything
- Not MongoDB triggers (they do not exist)

This repository demonstrates only the consistency layer.

## When to use this pattern

Use change streams when:

- You denormalize for read performance
- Updates fan out to many documents
- You can tolerate eventual consistency
- You want to avoid multi-document transactions

If you need strict consistency, normalize more or use transactions.

## License

MIT
