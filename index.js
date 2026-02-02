import { MongoClient } from "mongodb";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "conduit";

if (!MONGO_URI) throw new Error("Missing MONGO_URI");

const client = new MongoClient(MONGO_URI);

async function main() {
  await client.connect();
  console.log("Connected to MongoDB Atlas");

  const db = client.db(MONGO_DB_NAME);
  const usersCollection = db.collection("users");
  const articlesCollection = db.collection("articles");
  const commentsCollection = db.collection("comments");
  const tagsCollection = db.collection("tags");
  const stateCollection = db.collection("sync_state");

  // --- USERS STREAM ---
  const userState = await stateCollection.findOne({
    _id: "user_profile_sync",
  });
  const userStream = usersCollection.watch([], {
    fullDocument: "updateLookup",
    resumeAfter: userState?.resumeToken,
  })(async () => {
    console.log("Watching user updates...");
    for await (const change of userStream) {
      try {
        await handleUserChange(change, articlesCollection, commentsCollection);
        // save resume token
        await stateCollection.updateOne(
          {
            _id: "user_profile_sync",
          },
          {
            $set: {
              resumeToken: change._id,
            },
          },
          {
            upsert: true,
          },
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
  })(async () => {
    console.log("Watching article updates for tags...");
    for await (const change of articleStream) {
      try {
        await handleArticleChange(change, tagsCollection);
        // save resume token
        await stateCollection.updateOne(
          {
            _id: "article_tag_sync",
          },
          {
            $set: {
              resumeToken: change._id,
            },
          },
          {
            upsert: true,
          },
        );
      } catch (err) {
        console.error("Article change processing error:", err);
      }
    }
  })();
}

// --- USERS CHANGE HANDLER ---
function profileChanged(change) {
  const fields = change.updateDescription?.updatedFields || {};
  return "username" in fields || "image" in fields;
}

async function handleUserChange(change, articlesCol, commentsCol) {
  if (!profileChanged(change)) return;
  const userId = change.documentKey._id;
  const { username, image } = change.fullDocument;

  const update = {};
  if (username) update.authorUsername = username;
  if (image) update.authorImage = image;
  if (Object.keys(update).length === 0) return;

  console.log(`Syncing profile for user ${userId}`);

  await Promise.all([
    articlesCol.updateMany(
      {
        authorId: userId,
      },
      {
        $set: update,
      },
    ),
    commentsCol.updateMany(
      {
        authorId: userId,
      },
      {
        $set: update,
      },
    ),
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
      {
        _id: t,
      },
      {
        $inc: {
          articleCount: 1,
        },
      },
      {
        upsert: true,
      },
    );
  }

  // Tags removed
  const removed = oldTags.filter((t) => !newTags.includes(t));
  for (const t of removed) {
    const res = await tagsCol.findOneAndUpdate(
      {
        _id: t,
      },
      {
        $inc: {
          articleCount: -1,
        },
      },
      {
        returnDocument: "after",
      },
    );
    if (res.value?.articleCount <= 0) {
      await tagsCol.deleteOne({
        _id: t,
      });
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
