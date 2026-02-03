# RealWorld MongoDB Change Stream

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

```bash
npm start
```

## Testing

End-to-end tests use a real MongoDB instance and assume the worker is already running.

```bash
npm test
```

Tests validate that:

- Updating users propagates changes to articles and comments
- Updating article tags updates the global tag list
- Adding or removing favorites updates favoritesCount
- Rapid or conflicting updates converge correctly

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
