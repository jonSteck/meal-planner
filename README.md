# Family Meal Planner (local)

A weekly meal planner and shopping list that runs entirely on your laptop.
Includes a recipe bank you can add to by pasting a recipe link (or entering
recipes manually), and a cooking view for following recipes step-by-step.

## Setup (one time)

1. **Install Node.js 18 or newer**, if you don't already have it:
   https://nodejs.org (choose the LTS version)

2. **Open Terminal** and go to this folder:
   ```
   cd path/to/meal-planner-local
   ```

3. **Install dependencies:**
   ```
   npm install
   ```

4. **Set up a free MongoDB Atlas database** — this is where your weekly
   menus and recipe bank get saved. It takes about five minutes:

   a. Go to https://www.mongodb.com/cloud/atlas/register and create a free
      account (no credit card required for the free tier).

   b. When prompted to create a cluster, choose the **free M0** tier, pick
      any region close to you, and create it. This takes a minute or two
      to provision.

   c. Under **Security > Database Access**, add a database user with a
      username and password (autogenerate one if you like) — save these,
      you'll need them in a moment.

   d. Under **Security > Network Access**, add an IP address. For a home
      server the simplest option is **"Allow access from anywhere"**
      (0.0.0.0/0) — your database is still protected by the username and
      password, just don't share your connection string with anyone. If
      you'd rather restrict it, add your current public IP, but note home
      internet IPs can change over time, which would require updating this.

   e. Click **Connect** on your cluster, choose **Drivers**, select
      Node.js, and copy the connection string. It looks like:
      ```
      mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
      ```

5. **Add the connection string to this project.** Copy the example env
   file:
   ```
   cp .env.example .env
   ```
   Then open `.env` in any text editor and paste your connection string in,
   replacing `<username>` and `<password>` with the real values from step 4c:
   ```
   MONGODB_URI=mongodb+srv://myuser:mypassword@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

6. **Start the server:**
   ```
   npm start
   ```
   You should see:
   ```
   Connected to MongoDB Atlas (database "meal_planner")
   Family meal planner running at http://localhost:3000
   ```
   If instead you see a warning about not being connected, double check the
   connection string and the Network Access step above.

7. **Open** http://localhost:3000 **in your browser.**

## Using it again later

Just repeat step 6 and 7 — open Terminal, `cd` into the folder, run
`npm start`, then open the URL. Keep the Terminal window open while you use
the planner; closing it stops the server.

## Using it from other devices on your network

When you start the server, it prints one or more `http://192.168.x.x:3000`
style addresses (or similar) alongside the `localhost` one — those work
from any phone, tablet, or other computer on the same Wi-Fi network.

The first time you do this, **macOS will likely ask whether to allow
incoming network connections for Node** — click Allow. If it doesn't ask
and other devices still can't connect, check System Settings > Network >
Firewall.

Everyone who opens the app — on your laptop or any other device — sees and
edits the **same** weekly menu and recipe bank (see below). Changes made
on one device show up on others within about 20 seconds automatically, or
immediately if you switch back to the tab.

## How your data is stored

Your weekly menus and recipe bank are saved in your MongoDB Atlas
database, not in the browser or on this laptop. That's what makes it
shared: every device talks to the same server, which talks to the same
cloud database, so everyone sees the same data — from anywhere, not just
your home network, if you ever host the server somewhere other than your
laptop.

The server needs to be running (`npm start`) and able to reach the
internet for the app to work, including on the laptop hosting it. If
you're offline or MongoDB Atlas is unreachable, you'll see a banner in the
app saying changes won't be saved — the app still loads, but nothing
persists until the connection is back.

**Backing up or resetting your data:** open your cluster in the Atlas web
dashboard, go to **Collections**, and look at the `meal_planner` database's
`kv` collection — each document is one saved item (the recipe bank, or one
week's menu). You can export, edit, or delete documents there directly if
you ever need to.

**Upgrading from an older version:** if you used an earlier version of
this app that stored data in the browser or a local file instead, the
first time you open the app after upgrading (with your `.env` configured)
it automatically copies that browser's data to the database — one-time,
and only if the database doesn't already have data — so you don't lose
anything you'd already built up.

## Importing recipes from a link

When you paste a recipe URL and hit Fetch, the server reads the recipe data
the site itself embeds in the page — the same structured data most recipe
sites use to get Google's recipe rich-results (ingredients, steps, and
timing, all exact). This works for the large majority of recipe sites, and
doesn't touch the database or need any API key.

If a page doesn't have that data (a handful of sites load content
dynamically via JavaScript, or are paywalled), you'll be prompted to add
the recipe manually instead — quick, and always works. Every recipe in the
bank, imported or manual, can also be edited afterward with the pencil icon.

## Troubleshooting

- **Port already in use** — another program is using port 3000. Set a
  different port before starting, e.g. `PORT=3001 npm start`.
- **"Not connected to the database" banner** — check `.env` has the right
  `MONGODB_URI`, that the password in it doesn't contain unescaped special
  characters (if your password has `@`, `:`, `/`, or similar, URL-encode
  it, or regenerate a simpler password in Atlas), and that your current
  network is allowed under Atlas's Network Access settings.
- **Recipe link import comes back empty or wrong** — extraction quality
  depends on the recipe site; you'll see a preview before it's added, and
  can discard and add the recipe manually instead, or edit it after adding.
- **Changes from another device aren't showing up** — the app checks for
  updates roughly every 20 seconds, or right away when you switch back to
  its tab; if it's been longer than that and you still don't see a change,
  reload the page.
