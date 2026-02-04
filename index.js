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
  const favoritesCollection = db.collection("favorites");
  const stateCollection = db.collection("sync_state");

  // Enable changeStreamPreAndPostImages for users and articles collections
  await ensurePreAndPostImages(db, "users");
  await ensurePreAndPostImages(db, "articles");
  await ensurePreAndPostImages(db, "favorites");

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

  // --- FAVORITES STREAM ---
  const favoritesState = await stateCollection.findOne({
    _id: "favorites_count_sync",
  });
  const favoritesStream = favoritesCollection.watch([], {
    fullDocument: "updateLookup",
    fullDocumentBeforeChange: "required",
    resumeAfter: favoritesState?.resumeToken,
  });

  (async () => {
    console.log("Watching favorites for articles count...");
    for await (const change of favoritesStream) {
      try {
        await handleFavoriteChange(change, articlesCollection);
        // save resume token
        await stateCollection.updateOne(
          { _id: "favorites_count_sync" },
          { $set: { resumeToken: change._id } },
          { upsert: true },
        );
      } catch (err) {
        console.error("Favorite change processing error:", err);
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
  process.stdout.write("[U]");
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
  process.stdout.write("[A]");
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
  process.stdout.write("[F]");
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
