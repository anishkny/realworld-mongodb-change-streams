import dotEnvExtended from "dotenv-extended";
import { MongoClient } from "mongodb";

dotEnvExtended.load();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI");

const client = new MongoClient(MONGODB_URI);
async function main() {
  await client.connect();
  console.log("Connected to MongoDB Atlas");

  const db = client.db();
  const usersCollection = db.collection("users");
  const articlesCollection = db.collection("articles");
  const commentsCollection = db.collection("comments");
  const tagsCollection = db.collection("tags");
  const stateCollection = db.collection("sync_state");

  // Enable changeStreamPreAndPostImages for users and articles collections
  await ensurePreAndPostImages(db, "users");
  await ensurePreAndPostImages(db, "articles");

  // --- USERS STREAM ---
  const userState = await stateCollection.findOne({ _id: "user_profile_sync" });
  const userStream = usersCollection.watch([], {
    fullDocument: "updateLookup",
    resumeAfter: userState?.resumeToken,
  });

  (async () => {
    console.log("Watching user updates...");
    for await (const change of userStream) {
      try {
        await handleUserChange(change, articlesCollection, commentsCollection);
        // save resume token
        await stateCollection.updateOne(
          { _id: "user_profile_sync" },
          { $set: { resumeToken: change._id } },
          { upsert: true },
        );
      } catch (err) {
        console.error("User change processing error:", err);
      }
    }
  })();

  // --- ARTICLES STREAM ---
  const articleState = await stateCollection.findOne({
    _id: "article_tag_sync",
  });
  const articleStream = articlesCollection.watch([], {
    fullDocument: "updateLookup",
    fullDocumentBeforeChange: "required",
    resumeAfter: articleState?.resumeToken,
  });

  (async () => {
    console.log("Watching article updates for tags...");
    for await (const change of articleStream) {
      try {
        await handleArticleChange(change, tagsCollection);
        // save resume token
        await stateCollection.updateOne(
          { _id: "article_tag_sync" },
          { $set: { resumeToken: change._id } },
          { upsert: true },
        );
      } catch (err) {
        console.error("Article change processing error:", err);
      }
    }
  })();

  console.log("Change streams set up and running.");
}

// --- USERS CHANGE HANDLER ---
function profileChanged(change) {
  const fields = change.updateDescription?.updatedFields || {};
  return "username" in fields || "image" in fields || "bio" in fields;
}

async function handleUserChange(change, articlesCol, commentsCol) {
  if (!profileChanged(change)) return;
  const userId = change.documentKey._id;
  const { username, image, bio } = change.fullDocument;

  const update = {};
  if (username) update.authorUsername = username;
  if (image) update.authorImage = image;
  if (bio) update.authorBio = bio;
  if (Object.keys(update).length === 0) return;

  console.log(`Syncing profile for user ${userId}`);
  await Promise.all([
    articlesCol.updateMany({ authorId: userId }, { $set: update }),
    commentsCol.updateMany({ authorId: userId }, { $set: update }),
  ]);
}

// --- ARTICLES CHANGE HANDLER (tags) ---
async function handleArticleChange(change, tagsCol) {
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
