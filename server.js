require("dotenv").config();
const express = require("express");
const path = require("path");
const os = require("os");
const { MongoClient } = require("mongodb");

// Node 18+ has fetch built in. On older Node versions, fall back to node-fetch.
const fetch = global.fetch || require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || "meal_planner";

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---- Key/value store, backed by a MongoDB Atlas collection ---- */
// Everyone hitting this server (any device on the network, or anywhere with
// the URL if you deploy it) reads and writes the same collection, so the
// weekly menu and recipe bank are shared rather than living separately in
// each browser's local storage. Each document is { _id: <key>, value: <data> }.

let collection = null; // set once connected; null means "not connected yet"

async function connectDB() {
  if (!MONGODB_URI) {
    console.log("\n⚠️  No MONGODB_URI found in .env — the app will load, but nothing will save.");
    console.log("   See .env.example and the README for how to set up a free MongoDB Atlas cluster.\n");
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    collection = client.db(DB_NAME).collection("kv");
    console.log(`Connected to MongoDB Atlas (database "${DB_NAME}")`);
  } catch (err) {
    console.error("\n⚠️  Couldn't connect to MongoDB:", err.message);
    console.error("   Check MONGODB_URI in your .env file and your Atlas Network Access settings.\n");
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: !!collection });
});

app.get("/api/data/:key", async (req, res) => {
  if (!collection) {
    return res.status(503).json({ error: { message: "Not connected to the database. Check the server's MONGODB_URI setup." } });
  }
  try {
    const doc = await collection.findOne({ _id: req.params.key });
    res.json({ key: req.params.key, value: doc ? doc.value : null });
  } catch (err) {
    console.error("DB read failed:", err);
    res.status(500).json({ error: { message: "Database read failed." } });
  }
});

app.put("/api/data/:key", async (req, res) => {
  if (!collection) {
    return res.status(503).json({ error: { message: "Not connected to the database. Check the server's MONGODB_URI setup." } });
  }
  if (!req.body || !("value" in req.body)) {
    return res.status(400).json({ error: { message: "Missing value in request body." } });
  }
  try {
    await collection.updateOne(
      { _id: req.params.key },
      { $set: { value: req.body.value, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("DB write failed:", err);
    res.status(500).json({ error: { message: "Database write failed." } });
  }
});

/* ---- Recipe import from structured page data (no API key needed) ---- */
// Most recipe sites embed a schema.org "Recipe" block as JSON-LD, used for
// Google's recipe rich results. We read that directly instead of asking an
// AI to guess at the page — it's exact, and free.

function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      blocks.push(JSON.parse(m[1].trim()));
    } catch (e) {
      // Some pages embed malformed or multi-object JSON-LD; skip those blocks.
    }
  }
  return blocks;
}

function findRecipeNode(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("Recipe")) return node;
  if (node["@graph"]) return findRecipeNode(node["@graph"]);
  return null;
}

function isoDurationToLabel(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!m) return "";
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  if (!h && !min) return "";
  if (h && min) return h + " hr " + min + " min";
  if (h) return h + " hr";
  return min + " min";
}

function flattenInstructions(instr) {
  if (!instr) return [];
  if (typeof instr === "string") {
    return instr.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(instr)) {
    const steps = [];
    instr.forEach((item) => {
      if (typeof item === "string") {
        steps.push(item.trim());
      } else if (item && typeof item === "object") {
        if (item["@type"] === "HowToSection" && Array.isArray(item.itemListElement)) {
          steps.push(...flattenInstructions(item.itemListElement));
        } else if (item.text) {
          steps.push(String(item.text).trim());
        } else if (item.name) {
          steps.push(String(item.name).trim());
        }
      }
    });
    return steps.filter(Boolean);
  }
  return [];
}

function guessTagsFromMetadata(node) {
  const raw = [node.keywords, node.recipeCategory, node.recipeCuisine, node.suitableForDiet]
    .flat()
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const tags = [];
  if (/vegetar|vegan/.test(raw)) tags.push("veg");
  if (/slow.?cooker|crock.?pot/.test(raw)) tags.push("slow");
  if (/kid|family/.test(raw)) tags.push("kid-friendly");
  if (/freez/.test(raw)) tags.push("freezer-friendly");
  if (/healthy|light/.test(raw)) tags.push("healthy");
  if (/quick|easy|30.?minute/.test(raw)) tags.push("quick");
  return tags;
}

function extractRecipeFromHTML(html, url) {
  const blocks = extractJsonLdBlocks(html);
  let node = null;
  for (const block of blocks) {
    node = findRecipeNode(block);
    if (node) break;
  }
  if (!node) return null;

  const name = typeof node.name === "string" && node.name.trim() ? node.name.trim() : "Untitled recipe";
  const ingredientsRaw = Array.isArray(node.recipeIngredient)
    ? node.recipeIngredient
    : Array.isArray(node.ingredients)
    ? node.ingredients
    : [];
  const instructions = flattenInstructions(node.recipeInstructions);
  const time = isoDurationToLabel(node.totalTime) || isoDurationToLabel(node.cookTime) || isoDurationToLabel(node.prepTime) || "";
  const tags = guessTagsFromMetadata(node);

  if (ingredientsRaw.length === 0) return null;

  return {
    name,
    time,
    tags,
    ingredientsRaw: ingredientsRaw.map(String),
    instructions,
    sourceUrl: url,
  };
}

app.post("/api/import-recipe", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: { message: "Missing url." } });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("bad protocol");
  } catch (e) {
    return res.status(400).json({ error: { message: "That doesn't look like a valid link." } });
  }

  try {
    const pageRes = await fetch(parsedUrl.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!pageRes.ok) {
      return res.status(502).json({ error: { message: "Couldn't load that page (status " + pageRes.status + ")." } });
    }
    const html = await pageRes.text();
    const recipe = extractRecipeFromHTML(html, parsedUrl.toString());
    if (!recipe) {
      return res.status(404).json({ error: { message: "No recipe data found on that page." } });
    }
    res.json({ recipe });
  } catch (err) {
    console.error("Recipe import failed:", err);
    res.status(500).json({ error: { message: "Couldn't reach that page. Check the link and try again." } });
  }
});

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (net.family === "IPv4" && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}

async function start() {
  await connectDB();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\nFamily meal planner running at http://localhost:${PORT}`);
    const lanAddresses = getLanAddresses();
    if (lanAddresses.length) {
      console.log("\nOther devices on your network (phone, tablet, etc.) can reach it at:");
      lanAddresses.forEach((addr) => console.log(`  http://${addr}:${PORT}`));
      console.log("\n(If it doesn't load from another device, macOS may be asking to allow incoming");
      console.log("connections for Node — check for a permission prompt, or System Settings > Network > Firewall.)\n");
    } else {
      console.log("\n(No network interface detected — this device may not be connected to a network.)\n");
    }
  });
}
start();
