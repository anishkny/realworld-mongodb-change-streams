import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import dotEnvExtended from "dotenv-extended";

dotEnvExtended.load();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI");

let client, db;

before(async () => {
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db();
});

after(async () => {
  await client.close();
});

describe("RealWorld MongoDB Change Streams E2E", async () => {
  let users, articles, comments, tags, favorites;

  // Clean collections before each test
  beforeEach(async () => {
    users = db.collection("users");
    articles = db.collection("articles");
    comments = db.collection("comments");
    tags = db.collection("tags");
    favorites = db.collection("favorites");

    await Promise.all([
      users.deleteMany({}),
      articles.deleteMany({}),
      comments.deleteMany({}),
      tags.deleteMany({}),
      favorites.deleteMany({}),
    ]);
  });

  it("should propogate user update to articles and comments", async () => {
    const userId = new ObjectId();
    await users.insertOne({
      _id: userId,
      username: "old",
      image: "old.png",
      bio: "old bio",
    });

    const articleId = new ObjectId();
    const commentId = new ObjectId();

    await articles.insertOne({
      _id: articleId,
      authorId: userId,
      authorUsername: "old",
      authorImage: "old.png",
      authorBio: "old bio",
      tagList: [],
    });
    await comments.insertOne({
      _id: commentId,
      authorId: userId,
      authorUsername: "old",
      authorImage: "old.png",
      authorBio: "old bio",
    });

    // Update user
    await users.updateOne(
      { _id: userId },
      { $set: { username: "new", image: "new.png", bio: "new bio" } },
    );

    await waitFor(async () => {
      const a = await articles.findOne({ _id: articleId });
      const c = await comments.findOne({ _id: commentId });
      return (
        a.authorUsername === "new" &&
        a.authorImage === "new.png" &&
        a.authorBio === "new bio" &&
        c.authorUsername === "new" &&
        c.authorImage === "new.png" &&
        c.authorBio === "new bio"
      );
    });

    const finalArticle = await articles.findOne({ _id: articleId });
    const finalComment = await comments.findOne({ _id: commentId });

    assert.equal(finalArticle.authorUsername, "new");
    assert.equal(finalArticle.authorImage, "new.png");
    assert.equal(finalArticle.authorBio, "new bio");
    assert.equal(finalComment.authorUsername, "new");
    assert.equal(finalComment.authorImage, "new.png");
    assert.equal(finalComment.authorBio, "new bio");
  });

  it("should propgate article insert/update to tags", async () => {
    const articleId = new ObjectId();
    const oldTags = ["tech", "js"];
    const newTags = ["js", "node", "mongodb"];

    await articles.insertOne({ _id: articleId, tagList: oldTags });

    // Update tags
    await articles.updateOne(
      { _id: articleId },
      { $set: { tagList: newTags } },
    );

    await waitFor(async () => {
      const allTags = await tags.find().toArray();
      const names = allTags.map((t) => t._id).sort();
      return (
        names.length === 3 &&
        names.includes("node") &&
        names.includes("mongodb")
      );
    });
  });

  it("should propogate article deletion to tags", async () => {
    await tags.insertMany([
      { _id: "js", articleCount: 2 },
      { _id: "node", articleCount: 1 },
    ]);
    const articleId = new ObjectId();
    await articles.insertOne({
      _id: articleId,
      tagList: ["js", "node", "perf"],
    });

    // Verify tags state: js: 3, node: 2, perf: 1
    await waitFor(async () => {
      const jsTag = await tags.findOne({ _id: "js" });
      const nodeTag = await tags.findOne({ _id: "node" });
      const perfTag = await tags.findOne({ _id: "perf" });
      return (
        jsTag.articleCount === 3 &&
        nodeTag.articleCount === 2 &&
        perfTag.articleCount === 1
      );
    });

    // Delete article
    await articles.deleteOne({ _id: articleId });

    // Verify tags state: js: 2, node: 1, perf: deleted
    await waitFor(async () => {
      const jsTag = await tags.findOne({ _id: "js" });
      const nodeTag = await tags.findOne({ _id: "node" });
      const perfTag = await tags.findOne({ _id: "perf" });
      return jsTag.articleCount === 2 && nodeTag.articleCount === 1 && !perfTag;
    });
  });

  it.skip("should compute favorites count correctly", async () => {
    const articleId = new ObjectId();
    const userId = new ObjectId();
    await articles.insertOne({
      _id: articleId,
      favoritesCount: 0,
      tagList: [],
    });

    // Simulate favorite
    await favorites.insertOne({ articleId, userId });
    await articles.updateOne(
      { _id: articleId },
      { $inc: { favoritesCount: 1 } },
    ); // normally handled by worker

    await waitFor(async () => {
      const a = await articles.findOne({ _id: articleId });
      return a.favoritesCount === 1;
    });

    // Simulate unfavorite
    await favorites.deleteOne({ articleId, userId });
    await articles.updateOne(
      { _id: articleId },
      { $inc: { favoritesCount: -1 } },
    ); // normally handled by worker

    await waitFor(async () => {
      const a = await articles.findOne({ _id: articleId });
      return a.favoritesCount === 0;
    });
  });

  it("should handle no-op updates correctly", async () => {
    const userId = new ObjectId();
    await users.insertOne({
      _id: userId,
      username: "same",
      image: "same.png",
      bio: "same",
    });

    const articleId = new ObjectId();
    const commentId = new ObjectId();

    await articles.insertOne({
      _id: articleId,
      authorId: userId,
      authorUsername: "same",
      authorImage: "same.png",
      authorBio: "same",
      tagList: [],
    });
    await comments.insertOne({
      _id: commentId,
      authorId: userId,
      authorUsername: "same",
      authorImage: "same.png",
      authorBio: "same",
    });

    // Update with same values
    await users.updateOne(
      { _id: userId },
      { $set: { username: "same", image: "same.png", bio: "same" } },
    );

    await waitFor(async () => {
      const a = await articles.findOne({ _id: articleId });
      const c = await comments.findOne({ _id: commentId });
      return a.authorUsername === "same" && c.authorImage === "same.png";
    });
  });

  it("should handle rapid conflicting updates", async () => {
    const userId = new ObjectId();
    await users.insertOne({ _id: userId, username: "v1", image: "v1.png" });

    const articleId = new ObjectId();
    await articles.insertOne({
      _id: articleId,
      authorId: userId,
      authorUsername: "v1",
      authorImage: "v1.png",
      tagList: [],
    });

    // Rapid updates
    await users.updateOne({ _id: userId }, { $set: { username: "v2" } });
    await users.updateOne(
      { _id: userId },
      { $set: { username: "v3", image: "v3.png" } },
    );

    await waitFor(async () => {
      const a = await articles.findOne({ _id: articleId });
      return a.authorUsername === "v3" && a.authorImage === "v3.png";
    });
  });
});

// --------------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------------

/**
 * Helper: polls a callback until it returns true or timeout
 * @param {Function} fn async callback returning boolean
 * @param {number} interval ms
 * @param {number} timeout ms
 */
async function waitFor(fn, interval = 100, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((res) => setTimeout(res, interval));
  }
  throw new Error("Timeout waiting for condition");
}
