# Club Sandwich Streaming

A movie & TV streaming site in the Club Sandwich brand (amber `#FF9F1C`, Nunito
font). Browsing, artwork, search and details come from
**[TMDB](https://www.themoviedb.org/)**; the actual video streams are served by
**[VidLink](https://vidlink.pro/)**'s embedded player.

![TMDB](https://img.shields.io/badge/TMDB-metadata-01d277) ![VidLink](https://img.shields.io/badge/VidLink-streams-ff9f1c)

## Features

- Cinematic hero banner + horizontally-scrolling category rows
- **Movies** and **TV Shows** catalogs (trending, popular, top rated, by genre)
- Live **search** (movies + TV)
- Detail modal with rating, cast, genres and overview
- **TV season / episode picker** (pick any season, tap an episode to play)
- **Continue Watching** row driven by VidLink's playback progress events
- **My List** saved in your browser
- Fully responsive, dark UI

## Setup (2 minutes)

You only need a **free TMDB API key**.

1. Create a TMDB account: <https://www.themoviedb.org/signup>
2. Request an API key: <https://www.themoviedb.org/settings/api>
   (choose "Developer", it's instant and free)
3. Open `assets/js/config.js` and paste your key:

   ```js
   TMDB_API_KEY: "your_key_here",
   ```

   > Alternatively, paste a v4 **Read Access Token** into `TMDB_ACCESS_TOKEN`.

That's it — no key is needed for VidLink.

## Run it

Because the app makes browser `fetch` calls, serve it over `http://` (not by
double-clicking the file). Any static server works:

```powershell
# Python (built into most systems)
python -m http.server 5500

# or Node
npx serve .
```

Then open <http://localhost:5500>.

> Tip: in VS Code / Cursor you can also use the **Live Server** extension.

## Run as a desktop app (Electron)

The project is also a Windows desktop app — its own window, taskbar icon, no
browser and no separate server needed.

First time only, install dependencies:

```powershell
npm install
```

Then launch the app:

```powershell
npm start
```

> The very first launch downloads the Electron runtime (~150 MB) once, then it's
> cached and starts instantly after that.

### Build a standalone installer / portable .exe

```powershell
npm run dist            # installer (.exe) + portable, output in the release/ folder
npm run dist:portable   # just a single portable .exe
```

The built files land in the `release/` folder. The installer creates a desktop
shortcut and lets you pick the install location.

### App icon

The app icon comes from `build/source-icon.png`. If you swap that image, run:

```powershell
npm run icons
```

This regenerates `build/icon.png`, `build/icon.ico`, and the PWA icons in
`assets/icons/`.

## Install as a web app (PWA) / host online

The site is also a Progressive Web App, so it can be **installed** from a
browser and **hosted online** for any device.

1. Serve it over `http://`/`https://` (see the local-server step above, or deploy
   it — see below).
2. In Chrome/Edge, open the site and click the **Install** icon in the address
   bar. It gets its own window and Start-menu/desktop icon (with the same
   Club Sandwich icon).

### Deploy it for free

Any static host works — no build step required. For example:

```powershell
# Netlify (drag-and-drop the folder at app.netlify.com, or:)
npx netlify-cli deploy --dir . --prod

# or Vercel
npx vercel --prod

# or GitHub Pages: push the folder to a repo and enable Pages
```

Then open the URL on any device and install it as a PWA.

> Note: hosting this publicly exposes your TMDB key in `assets/js/config.js`.
> For a public site, restrict/rotate the key or proxy TMDB requests.

## Discord Rich Presence setup (optional)

The desktop app can show **"Watching <title>"** on your Discord profile. It's off
until you add a free Client ID.

1. Go to <https://discord.com/developers/applications> and sign in.
2. Click **New Application**, name it `Club Sandwich Streaming`, accept, **Create**.
3. On the **General Information** page, copy the **Application ID** — that's your
   Client ID.
4. Paste it into `electron/discord-config.js`:

   ```js
   DISCORD_CLIENT_ID: "your_application_id_here",
   ```

5. (Optional, for the little logo next to the status) In the left sidebar go to
   **Rich Presence → Art Assets**, upload an image, and name it exactly `logo`.
6. Make sure the Discord desktop app is running, then start the app
   (`npm start`). Play something — your profile will show what you're watching.

If the Client ID is left blank, or Discord isn't running, the app simply skips
Discord — everything else works the same.

> After changing anything, rebuild the installer with `npm run dist` so your
> friend's copy includes it.

## Auto-update setup (optional)

When configured, the installed app checks your **GitHub Releases** on launch and
auto-installs new versions on quit — so you never have to re-send the `.exe`.
It's dormant until you do this once:

1. Create a **free public GitHub repo**, e.g. `club-sandwich-streaming`.
2. Put your repo in `electron/update-config.js`:

   ```js
   OWNER: "your-github-username",
   REPO: "club-sandwich-streaming",
   ```

3. Add a matching `publish` block to `package.json` under `build`:

   ```json
   "publish": [
     { "provider": "github", "owner": "your-github-username", "repo": "club-sandwich-streaming" }
   ]
   ```

4. Create a GitHub **Personal Access Token** (classic, `repo` scope) and set it
   in your terminal so electron-builder can upload the release:

   ```powershell
   $env:GH_TOKEN = "your_token_here"
   ```

5. Bump `"version"` in `package.json` (e.g. `1.0.1`) and publish:

   ```powershell
   npm run release
   ```

That uploads the installer + update metadata to a GitHub Release. Anyone running
an older installed copy will silently update to the new version. To ship an
update later, just bump the version and run `npm run release` again.

> Send your friend the installer **once**. After that, auto-update handles it.

## How playback works

VidLink is embedded via an `<iframe>` using TMDB IDs:

| Type  | URL pattern                                            |
| ----- | ------------------------------------------------------ |
| Movie | `https://vidlink.pro/movie/{tmdbId}`                   |
| TV    | `https://vidlink.pro/tv/{tmdbId}/{season}/{episode}`   |

Player styling (brand colors, icons, next-episode button) is configured in the
`PLAYER` block of `assets/js/config.js`. Autoplay / resume / remembering the
source are user toggles in the player's ⚙ settings.

You can switch **sources** from the dropdown in the player bar. VidLink is the
default; extra backup providers (VidSrc, 2Embed, AutoEmbed, …) are listed in the
`SOURCES` array of `assets/js/config.js` — add or remove them freely.

The site listens for VidLink's `postMessage` `MEDIA_DATA` events to build the
**Continue Watching** row and to **resume** playback (stored in `localStorage`).

## Project structure

```
index.html
assets/
  css/style.css
  js/
    config.js   # <-- put your TMDB key here + player options
    tmdb.js     # TMDB API wrapper
    player.js   # VidLink URL builder + progress tracking
    ui.js       # DOM rendering (cards, rows, hero, modal, player)
    app.js      # routing, data loading, events
```

## Notes / legal

This is a demo front-end. It uses the TMDB API but is not endorsed or certified
by TMDB. Streams are provided by third-party VidLink; you are responsible for
how you use it and for complying with the laws in your jurisdiction.
