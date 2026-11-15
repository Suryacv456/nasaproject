# SPHEREx ChronoScope

Multi-epoch sky blink comparator + 102-band SPHEREx spectra. Plain HTML/CSS/JS frontend (no build step), Flask backend, optional PHP gateway.

## Run
```bash
cd backend
pip install flask numpy requests            # optional for live mode: astropy astroquery
python app.py                               # http://localhost:5000  (serves the frontend too)
```
PHP gateway (optional): `php -S localhost:8080 -t .` from the project root, then open
`http://localhost:8080/frontend/index.html?proxy=../php/api.php`. Set `CHRONOSCOPE_BACKEND` if Python runs elsewhere.

## Data modes
- **Demo engine (default, always works):** deterministic synthetic multi-epoch cutouts, 102-band spectra, light curves, Gaia/WISE/NEOSSat overlays for the 5 benchmark targets. Badge shows `DEMO DATA`.
- **Live hooks:** `backend/app.py` has `astroquery` detection and a Sesame (SIMBAD) name resolver. Real IRSA SPHEREx / Gaia TAP / CADC NEOSSat fetches are **not yet implemented**; the `/api/cutouts` and `/api/catalogs` handlers are where to add them, falling back to demo on error. Demo values (positions, proper motions) are approximate, not catalogue-exact.

## Features
Coordinate/name search (sexagesimal or decimal), shareable URL state, FOV presets + scale bar, blink player (play, step, interval, loop/ping-pong, scrubber with MJD/UTC), image math (blink, subtract, mean/median coadd, RGB motion trail), stretch/colormaps, WCS grid + live RA/Dec, click-to-inspect spectrum / light curve / FITS header + flags, proper-motion tool, Gaia/WISE/NEOSSat overlays, filterable cross-match table with IRSA/CADC links, and a drag-and-drop upload studio (FITS, PNG, JPG, WEBP; TIFF must be converted) with X/Y/rotation nudges.
Shortcuts: Space play/pause, ←/→ step.

## 60-second demo
1. (0–10s) Open the app, click **WISE 0855** — blink plays; the faint brown dwarf hops across epochs.
2. (10–20s) Switch **Image math → Subtract**: dipole pair marks the motion. Try **RGB motion trail**.
3. (20–30s) Click **Barnard's Star**, enable **Proper-motion tool**, click it in two epochs: read μ in mas/yr.
4. (30–42s) Click the source: **102-band spectrum** with H₂O/CH₄/CO/CO₂ markers; compare a cold dwarf vs **R Draconis**.
5. (42–52s) **R Draconis → Light curve** tab shows Mira pulsation; toggle Gaia/NEOSSat overlays.
6. (52–60s) **+ Upload Images**: drop 2+ images, nudge-align, load; hit **Share URL**.
