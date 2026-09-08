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

/* ---- Google login, gating access by household ---- */
// Each "household" is a named group of emails that share one view — the
// same weekly menu and recipe bank. Different households never see each
// other's data. Config format (env var HOUSEHOLDS):
//   householdId:email1,email2;anotherHousehold:email3,email4
// Falls back to the older ALLOWED_EMAILS (a flat comma list, no grouping)
// as a single household called "default", for anyone upgrading from before
// households existed.

function parseHouseholds() {
  const emailToHousehold = new Map();
  const raw = process.env.HOUSEHOLDS;
  if (raw && raw.trim()) {
    raw.split(";").map((s) => s.trim()).filter(Boolean).forEach((part) => {
      const colonIdx = part.indexOf(":");
      if (colonIdx === -1) return;
      const id = part.slice(0, colonIdx).trim();
      const emails = part.slice(colonIdx + 1).split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      if (!id || !emails.length) return;
      emails.forEach((e) => emailToHousehold.set(e, id));
    });
  } else if (process.env.ALLOWED_EMAILS) {
    (process.env.ALLOWED_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
      .forEach((e) => emailToHousehold.set(e, "default"));
  }
  return emailToHousehold;
}

const EMAIL_TO_HOUSEHOLD = parseHouseholds();
const CONFIGURED_HOUSEHOLD_IDS = [...new Set(EMAIL_TO_HOUSEHOLD.values())];
// If there's exactly one household configured, its members are eligible to
// automatically inherit data saved before households existed (see the GET
// handler below). Add a second household only after that one-time migration
// has had a chance to run — see the README.
const SOLE_HOUSEHOLD_ID = CONFIGURED_HOUSEHOLD_IDS.length === 1 ? CONFIGURED_HOUSEHOLD_IDS[0] : null;

function householdFor(email) {
  if (!email) return null;
  return EMAIL_TO_HOUSEHOLD.get(String(email).toLowerCase()) || null;
}

// The household that signed-in-but-unlisted visitors get a read-only view
// of. Defaults to the sole configured household (the common case — one
// family, want anyone else who signs in to see it but not edit it).
// Set DEFAULT_HOUSEHOLD explicitly once you have more than one household,
// to control which one strangers land in read-only; leave it unset (with
// multiple households configured) to give unlisted visitors no access at all.
const DEFAULT_HOUSEHOLD_ID = process.env.DEFAULT_HOUSEHOLD || SOLE_HOUSEHOLD_ID || null;

if (CONFIGURED_HOUSEHOLD_IDS.length === 0) {
  console.log("\n⚠️  No households configured (HOUSEHOLDS, or the older ALLOWED_EMAILS, is empty)");
  console.log("   — everyone who signs in will see a \"not part of a household\" screen. See the README.\n");
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

// Resolves what a signed-in user can see: their own household (full access),
// or the default household read-only if they're not a member of any, or
// nothing at all if there's no default to fall back to.
function resolveAccess(email) {
  const membership = householdFor(email);
  if (membership) return { householdId: membership, readOnly: false };
  if (DEFAULT_HOUSEHOLD_ID) return { householdId: DEFAULT_HOUSEHOLD_ID, readOnly: true };
  return null;
}

app.get("/api/me", (req, res) => {
  const authenticated = authEnabled && req.isAuthenticated && req.isAuthenticated();
  const email = authenticated ? req.user.email : null;
  const access = authenticated ? resolveAccess(email) : null;
  res.json({
    authConfigured: authEnabled,
    authenticated: !!authenticated,
    household: access ? access.householdId : null,
    readOnly: access ? access.readOnly : false,
    email,
    name: authenticated ? req.user.name : null,
  });
});

function requireHouseholdRead(req, res, next) {
  if (!authEnabled) {
    return res.status(503).json({ error: { message: "Login isn't configured on this server yet." } });
  }
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ error: { message: "Sign in to continue." } });
  }
  const access = resolveAccess(req.user.email);
  if (!access) {
    return res.status(403).json({ error: { message: "This Google account isn't part of any household on this app." } });
  }
  req.householdId = access.householdId;
  req.readOnly = access.readOnly;
  next();
}
function requireHouseholdWrite(req, res, next) {
  requireHouseholdRead(req, res, () => {
    if (req.readOnly) {
      return res.status(403).json({ error: { message: "This Google account can view this household's data but isn't authorized to make changes." } });
    }
    next();
  });
}

app.use(express.static(path.join(__dirname, "public")));

/* ---- Key/value store, backed by a MongoDB Atlas collection ---- */
// Each household reads and writes its own namespaced slice of the same
// collection, so different households never see each other's weekly menu
// or recipe bank, but everyone within a household shares one. Documents are
// stored as { _id: "<householdId>::<key>", value: <data> }.

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

app.get("/api/data/:key", requireHouseholdRead, async (req, res) => {
  if (!collection) {
    return res.status(503).json({ error: { message: "Not connected to the database. Check the server's MONGODB_URI setup." } });
  }
  try {
    const namespacedKey = req.householdId + "::" + req.params.key;
    let doc = await collection.findOne({ _id: namespacedKey });
    if (!doc && SOLE_HOUSEHOLD_ID && req.householdId === SOLE_HOUSEHOLD_ID) {
      // One-time migration: this key hasn't been saved under the new
      // namespaced form yet, but this is the only configured household, so
      // check for data saved before households existed (a flat, unprefixed
      // key) and adopt it — then write it forward so future reads don't
      // need this fallback.
      const legacyDoc = await collection.findOne({ _id: req.params.key });
      if (legacyDoc) {
        await collection.updateOne(
          { _id: namespacedKey },
          { $set: { value: legacyDoc.value, updatedAt: new Date() } },
          { upsert: true }
        );
        doc = legacyDoc;
      }
    }
    res.json({ key: req.params.key, value: doc ? doc.value : null });
  } catch (err) {
    console.error("DB read failed:", err);
    res.status(500).json({ error: { message: "Database read failed." } });
  }
});

app.put("/api/data/:key", requireHouseholdWrite, async (req, res) => {
  if (!collection) {
    return res.status(503).json({ error: { message: "Not connected to the database. Check the server's MONGODB_URI setup." } });
  }
  if (!req.body || !("value" in req.body)) {
    return res.status(400).json({ error: { message: "Missing value in request body." } });
  }
  try {
    const namespacedKey = req.householdId + "::" + req.params.key;
    await collection.updateOne(
      { _id: namespacedKey },
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

app.post("/api/import-recipe", requireHouseholdWrite, async (req, res) => {
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

/* ---- Instagram caption parsing (deterministic, no AI) ---- */
// Tailored to one creator's consistent post structure:
//   <recipe name> — <blurb>
//   Full Recipe (Makes approx. N ...)
//   * <ingredient name> — <qty><unit> [/ <alt qty/unit>] [(note)]
//   ...
//   Method:
//   1. <step>
//   2. <step>
//   ...
// Everything after the numbered steps (macros, verdict, credit, hashtags)
// is ignored. Instagram itself is not fetched for the caption in most cases
// (see the route below) — this expects the caption as plain text, either
// from a best-effort meta-tag scrape or pasted in by the user.

function decodeHtmlEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Reformats one "name — qty" caption line into the "qty unit name" shape
// the client's existing ingredient parser already understands, so no
// unit/section logic needs to be duplicated here.
function reformatIngredientLine(raw) {
  const dashIdx = raw.indexOf(" — ");
  if (dashIdx === -1) return raw;
  const namePart = raw.slice(0, dashIdx).trim();
  let qtyPart = raw.slice(dashIdx + 3).trim();
  let note = "";
  const noteMatch = qtyPart.match(/\s*(\([^)]*\))\s*$/);
  if (noteMatch) {
    note = " " + noteMatch[1];
    qtyPart = qtyPart.slice(0, noteMatch.index).trim();
  }
  qtyPart = qtyPart.split(" / ")[0].trim(); // prefer the first-listed unit, e.g. "125g / 3/4 cup" -> "125g"
  qtyPart = qtyPart.replace(/^(\d+(?:\.\d+)?)([a-zA-Z]+)$/, "$1 $2"); // "125g" -> "125 g"
  return (qtyPart + " " + namePart + note).trim();
}

function parseCreatorCaption(rawText, sourceUrl) {
  const lines = rawText.split("\n").map((l) => l.trim());

  const fullRecipeIdx = lines.findIndex((l) => /^full recipe/i.test(l));
  const methodIdx = lines.findIndex((l) => /^method:?$/i.test(l));
  if (fullRecipeIdx === -1 || methodIdx === -1 || methodIdx < fullRecipeIdx) return null;

  let name = "Untitled recipe";
  for (let i = fullRecipeIdx - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue;
    if (/^[✅❌]/.test(l)) continue;
    if (/hype or hoax/i.test(l)) continue;
    const dashIdx = l.indexOf(" — ");
    name = dashIdx !== -1 ? l.slice(0, dashIdx).trim() : l.split(/[.!]/)[0].trim();
    break;
  }

  const ingredientsRaw = [];
  for (let i = fullRecipeIdx + 1; i < methodIdx; i++) {
    const l = lines[i];
    if (!l.startsWith("*") && !l.startsWith("•")) continue;
    ingredientsRaw.push(reformatIngredientLine(l.replace(/^[*•]\s*/, "")));
  }

  const instructions = [];
  for (let i = methodIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const m = l.match(/^\d+\.\s*(.*)$/);
    if (!m) break;
    instructions.push(m[1].trim());
  }

  if (ingredientsRaw.length === 0) return null;
  return { name, time: "", tags: [], ingredientsRaw, instructions, sourceUrl: sourceUrl || null };
}

app.post("/api/import-instagram", requireHouseholdWrite, async (req, res) => {
  const { url, captionText } = req.body || {};
  let text = typeof captionText === "string" ? captionText.trim() : "";
  let sourceUrl = null;

  if (typeof url === "string" && url.trim()) {
    try {
      sourceUrl = new URL(url.trim()).toString();
    } catch (e) {
      return res.status(400).json({ error: { message: "That doesn't look like a valid link." } });
    }
    if (!text) {
      // Best-effort only — Instagram frequently blocks non-browser requests
      // or serves a truncated/empty description here. This is not expected
      // to work reliably; pasting the caption is the dependable path.
      try {
        const pageRes = await fetch(sourceUrl, {
          redirect: "follow",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
          },
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          const m = html.match(/<meta property="og:description" content="([^"]*)"/i);
          if (m) text = decodeHtmlEntities(m[1]).trim();
        }
      } catch (err) {
        console.error("Instagram fetch attempt failed:", err.message);
      }
    }
  }

  if (!text) {
    return res.status(404).json({
      error: {
        message: "Couldn't automatically read that post's caption (Instagram often blocks this). Paste the caption text instead.",
      },
    });
  }

  const recipe = parseCreatorCaption(text, sourceUrl);
  if (!recipe) {
    return res.status(422).json({
      error: {
        message: 'Found text, but couldn\u2019t find the expected "Full Recipe" / "Method:" sections in it.',
      },
    });
  }
  res.json({ recipe });
});

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
