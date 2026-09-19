# Auckland Local Board Finder

A small mobile-first web app for an Auckland **Jet Lag: Hide + Seek** transit game.

It answers two questions:

1. **Which Auckland Local Board am I currently in?**
2. **Which Local Board is a particular game station in?**

The app contains the 74-station game list and loads the official **Stats NZ Territorial Authority Local Board 2026** boundaries. The spatial lookup happens entirely in the player's browser.

## What it does

- High-accuracy phone GPS lookup.
- Station search across all 74 game stations.
- Shows distance to the nearest Local Board boundary.
- Warns when GPS accuracy overlaps a boundary.
- Offers the nearest game station coordinate as a boundary tie-breaker.
- Displays an interactive SVG boundary map without any mapping library or API key.
- Installs as a PWA on supported devices.
- Caches the app shell and the last successfully loaded Local Board boundary data for offline use after the first online load.
- Sends no player location to a custom server.

## Data source

Local Board boundaries are loaded from:

Stats NZ – Tatauranga Aotearoa, **Territorial Authority Local Board 2026**  
Definitive as at **1 January 2026**.

Service page:
https://services2.arcgis.com/vKb0s8tBIA3bdocZ/ArcGIS/rest/services/Territorial_Authority_Local_Board_2026/FeatureServer/0

The browser requests only Auckland (`076xx`) boundaries in WGS84 and asks ArcGIS to simplify geometry by roughly 5 metres for fast phone loading.

## Suggested game rule

If the player's GPS accuracy reaches a Local Board boundary, use the **official coordinate of the game station they are physically at** as the tie-breaker.

The app applies a 25 m caution buffer in addition to the phone's reported GPS accuracy.

## Publish with GitHub Pages

1. Create a new GitHub repository, for example `auckland-board-finder`.
2. Upload every file and folder from this package to the root of the repository.
3. In GitHub, open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Choose the `main` branch and `/ (root)`, then save.
6. Wait for GitHub to give you a URL such as:
   `https://YOUR-USERNAME.github.io/auckland-board-finder/`
7. Open the URL on each phone once while online. Location access requires HTTPS, which GitHub Pages provides automatically.

After that first successful load, the PWA/service worker and IndexedDB cache make repeat use much more resilient when mobile data is patchy.

## Test locally

From this folder:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` on the same computer. Browsers normally allow geolocation on `localhost`. For testing GPS on a phone, use the deployed HTTPS GitHub Pages URL.

## Files

- `index.html` – interface.
- `styles.css` – mobile-first styling.
- `app.js` – application logic, GPS, station lookup, boundary loading and rendering.
- `geo.js` – point-in-polygon and distance calculations.
- `stations.js` – the 74 game station coordinates.
- `sw.js` – offline/service-worker caching.
- `manifest.webmanifest` – installable PWA metadata.
- `icons/` – app icons.
