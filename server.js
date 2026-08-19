require("dotenv").config();
const express = require("express");
const path = require("path");
const os = require("os");
const { MongoClient } = require("mongodb");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

// Node 18+ has fetch built in. On older Node versions, fall back to node-fetch.
const fetch = global.fetch || require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || "meal_planner";

// Render (and most hosts) sit behind a reverse proxy that terminates HTTPS
// and forwards plain HTTP internally. Without this, Express can't tell the
// original connection was secure, and "secure" session cookies never get set.
app.set("trust proxy", 1);

app.use(express.json({ limit: "2mb" }));

/* ---- Google login, gating access to a fixed list of allowed emails ---- */

const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
function isAuthorized(email) {
  return !!email && ALLOWED_EMAILS.has(String(email).toLowerCase());
}

const authEnabled = !!(
  MONGODB_URI &&
  process.env.SESSION_SECRET &&
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET
);

if (!authEnabled) {
  console.log("\n⚠️  Login isn't fully configured (need MONGODB_URI, SESSION_SECRET,");
  console.log("   GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET in .env) — sign-in is disabled");
  console.log("   and the app will refuse all data access until it's set up. See the README.\n");
}

if (authEnabled) {
  const sessionStore = MongoStore.create({ mongoUrl: MONGODB_URI, dbName: DB_NAME, collectionName: "sessions" });
  // connect-mongo emits 'error' on connection problems; Node treats an unhandled
  // 'error' event as fatal and kills the whole process, so this listener is
  // required, not optional — without it, a bad/unreachable MONGODB_URI crashes
  // the entire server instead of just disabling login gracefully.
  sessionStore.on("error", (err) => {
    console.error("\n⚠️  Session store (MongoDB) connection error:", err.message);
    console.error("   Sign-in may not work until this is fixed.\n");
  });

  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      cookie: {
        httpOnly: true,
        secure: "auto", // set the Secure flag automatically based on the (proxy-aware) request protocol
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      },
    })
  );
  app.use(passport.initialize());
  app.use(passport.session());

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback",
      },
      (accessToken, refreshToken, profile, done) => {
        const email = profile.emails && profile.emails[0] && profile.emails[0].value;
        const name = profile.displayName || (email ? email.split("@")[0] : "there");
        const picture = profile.photos && profile.photos[0] && profile.photos[0].value;
        return done(null, { email, name, picture });
      }
    )
  );

  app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/" }),
    (req, res) => res.redirect("/")
  );

  app.get("/auth/logout", (req, res) => {
    req.logout(() => res.redirect("/"));
  });
}

app.get("/api/me", (req, res) => {
  const authenticated = authEnabled && req.isAuthenticated && req.isAuthenticated();
  const email = authenticated ? req.user.email : null;
  res.json({
    authConfigured: authEnabled,
    authenticated: !!authenticated,
    authorized: authenticated && isAuthorized(email),
    email,
    name: authenticated ? req.user.name : null,
  });
});

function requireSignedIn(req, res, next) {
  if (!authEnabled) {
    return res.status(503).json({ error: { message: "Login isn't configured on this server yet." } });
  }
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ error: { message: "Sign in to continue." } });
  }
  next();
}
function requireAuthorizedUser(req, res, next) {
  requireSignedIn(req, res, () => {
    if (!isAuthorized(req.user.email)) {
      return res.status(403).json({ error: { message: "This Google account can view the app but isn't authorized to make changes." } });
    }
    next();
  });
}

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

app.get("/api/data/:key", requireSignedIn, async (req, res) => {
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

app.put("/api/data/:key", requireAuthorizedUser, async (req, res) => {
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

app.post("/api/import-recipe", requireAuthorizedUser, async (req, res) => {
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

// Last line of defense: log and keep running rather than let one bad async
// error (e.g. a transient DB hiccup somewhere we didn't explicitly catch)
// take the whole server down for every family member using it.
process.on("unhandledRejection", (err) => {
  console.error("\n⚠️  Unhandled error (server is still running):", err);
});
process.on("uncaughtException", (err) => {
  console.error("\n⚠️  Uncaught error (server is still running):", err);
});

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
