import dotEnvExtended from "dotenv-extended";
import { MongoClient } from "mongodb";

dotEnvExtended.load();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI");

const { SHARD_INDEX, SHARD_COUNT } = getShardConfig(process.env);

const client = new MongoClient(MONGODB_URI);

async function main() {
  await client.connect();
  console.log(
    `Connected to MongoDB Atlas (Shard ${SHARD_INDEX}/${SHARD_COUNT})`,
  );

  const db = client.db();
  const usersCollection = db.collection("users");
  const articlesCollection = db.collection("articles");
  const commentsCollection = db.collection("comments");
  const tagsCollection = db.collection("tags");
  const favoritesCollection = db.collection("favorites");
  const stateCollection = db.collection("sync_state");

  // Enable changeStreamPreAndPostImages for users and articles collections
  await ensurePreAndPostImages(db, "users");
  await ensurePreAndPostImages(db, "articles");
  await ensurePreAndPostImages(db, "favorites");

  const shardingPipeline = createShardingPipeline(SHARD_COUNT, SHARD_INDEX);

  // --- USERS STREAM ---
  const userStateId = `user_profile_sync_shard_${SHARD_INDEX}_of_${SHARD_COUNT}`;
  const userState = await stateCollection.findOne({ _id: userStateId });
  const userStream = usersCollection.watch(shardingPipeline, {
    fullDocument: "updateLookup",
    resumeAfter: userState?.resumeToken,
  });

  (async () => {
    for await (const change of userStream) {
      try {
        await handleUserChange(change, articlesCollection, commentsCollection);
        // save resume token
        await stateCollection.updateOne(
          { _id: userStateId },
          { $set: { resumeToken: change._id } },
          { upsert: true },
        );
      } catch (err) {
        console.error("User change processing error:", err);
      }
    }
  })();

  // --- ARTICLES STREAM ---
  const articleStateId = `article_tag_sync_shard_${SHARD_INDEX}_of_${SHARD_COUNT}`;
  const articleState = await stateCollection.findOne({
    _id: articleStateId,
  });
  const articleStream = articlesCollection.watch(shardingPipeline, {
    fullDocument: "updateLookup",
    fullDocumentBeforeChange: "required",
    resumeAfter: articleState?.resumeToken,
  });

  (async () => {
    for await (const change of articleStream) {
      try {
        await handleArticleChange(change, tagsCollection);
        // save resume token
        await stateCollection.updateOne(
          { _id: articleStateId },
          { $set: { resumeToken: change._id } },
          { upsert: true },
        );
      } catch (err) {
        console.error("Article change processing error:", err);
      }
    }
  })();

  // --- FAVORITES STREAM ---
  const favoritesStateId = `favorites_count_sync_shard_${SHARD_INDEX}_of_${SHARD_COUNT}`;
  const favoritesState = await stateCollection.findOne({
    _id: favoritesStateId,
  });
  const favoritesStream = favoritesCollection.watch(shardingPipeline, {
    fullDocument: "updateLookup",
    fullDocumentBeforeChange: "required",
    resumeAfter: favoritesState?.resumeToken,
  });

  (async () => {
    for await (const change of favoritesStream) {
      try {
        await handleFavoriteChange(change, articlesCollection);
        // save resume token
        await stateCollection.updateOne(
          { _id: favoritesStateId },
          { $set: { resumeToken: change._id } },
          { upsert: true },
        );
      } catch (err) {
        console.error("Favorite change processing error:", err);
      }
    }
  })();

  console.log(`__READY__SHARD__${SHARD_INDEX}_OF_${SHARD_COUNT}__`);
}

// --- USERS CHANGE HANDLER ---
function profileChanged(change) {
  const fields = change.updateDescription?.updatedFields || {};
  return "username" in fields || "image" in fields || "bio" in fields;
}

async function handleUserChange(change, articlesCol, commentsCol) {
  process.stdout.write(`U@${SHARD_INDEX}/${SHARD_COUNT} `);
  if (!profileChanged(change)) return;
  const userId = change.documentKey._id;
  const { username, image, bio } = change.fullDocument;

  const update = {};
  if (username) update.authorUsername = username;
  if (image) update.authorImage = image;
  if (bio) update.authorBio = bio;
  if (Object.keys(update).length === 0) return;

  await Promise.all([
    articlesCol.updateMany({ authorId: userId }, { $set: update }),
    commentsCol.updateMany({ authorId: userId }, { $set: update }),
  ]);
}

// --- ARTICLES CHANGE HANDLER (tags) ---
async function handleArticleChange(change, tagsCol) {
  process.stdout.write(`A@${SHARD_INDEX}/${SHARD_COUNT} `);
  const oldTags = change.fullDocumentBeforeChange?.tagList || [];
  const newTags = change.fullDocument?.tagList || [];

  // Tags added
  const added = newTags.filter((t) => !oldTags.includes(t));
  for (const t of added) {
    await tagsCol.updateOne(
      { _id: t },
      { $inc: { articleCount: 1 } },
      { upsert: true },
    );
  }

  // Tags removed
  const removed = oldTags.filter((t) => !newTags.includes(t));
  for (const t of removed) {
    const res = await tagsCol.findOneAndUpdate(
      { _id: t },
      { $inc: { articleCount: -1 } },
      { returnDocument: "after" },
    );
    if (res?.articleCount <= 0) {
      await tagsCol.deleteOne({ _id: t });
    }
  }
}

// --- FAVORITES CHANGE HANDLER ---
async function handleFavoriteChange(change, articlesCol) {
  process.stdout.write(`F@${SHARD_INDEX}/${SHARD_COUNT} `);
  const operationType = change.operationType;

  if (operationType === "insert") {
    // Favorite added: increment article's favoritesCount
    const articleId = change.fullDocument?.articleId;
    if (articleId) {
      await articlesCol.updateOne(
        { _id: articleId },
        { $inc: { favoritesCount: 1 } },
      );
    }
  } else if (operationType === "delete") {
    // Favorite removed: decrement article's favoritesCount
    const articleId = change.fullDocumentBeforeChange?.articleId;
    if (articleId) {
      await articlesCol.updateOne(
        { _id: articleId },
        { $inc: { favoritesCount: -1 } },
      );
    }
  }
}

async function ensurePreAndPostImages(db, collectionName) {
  const collections = await db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .toArray();

  if (collections.length === 0) {
    await db.createCollection(collectionName, {
      changeStreamPreAndPostImages: { enabled: true },
    });
    return;
  }

  await db.command({
    collMod: collectionName,
    changeStreamPreAndPostImages: { enabled: true },
  });
}

function getShardConfig(env) {
  const shardCount = env.SHARD_COUNT ? parseInt(env.SHARD_COUNT) : 1;
  const shardIndex = env.SHARD_INDEX ? parseInt(env.SHARD_INDEX) : 0;

  // Validate sharding configuration
  if (isNaN(shardCount) || shardCount < 1) {
    throw new Error("SHARD_COUNT must be a positive number");
  }
  if (isNaN(shardIndex) || shardIndex < 0) {
    throw new Error("SHARD_INDEX must be a non-negative number");
  }
  if (shardIndex >= shardCount) {
    throw new Error("SHARD_INDEX must be less than SHARD_COUNT");
  }

  return { SHARD_COUNT: shardCount, SHARD_INDEX: shardIndex };
}

function createShardingPipeline(shardCount, shardIndex) {
  return shardCount == 1
    ? []
    : [
        {
          $match: {
            $expr: {
              $eq: [
                {
                  $mod: [
                    {
                      $abs: {
                        $toLong: { $toHashedIndexKey: "$documentKey._id" },
                      },
                    },
                    shardCount,
                  ],
                },
                shardIndex,
              ],
            },
          },
        },
      ];
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
