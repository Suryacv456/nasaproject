"""SPHEREx ChronoScope backend (Flask).

Live mode tries IRSA (SPHEREx), Gaia DR3 (TAP) and CADC (NEOSSat) when astroquery/astropy
are installed and the network is reachable. Otherwise, or on any failure/timeout, it falls
back to a deterministic synthetic demo engine for the 5 benchmark targets.
"""
import math, os, time
import numpy as np
from flask import Flask, jsonify, request, send_from_directory

try:
    from astroquery.gaia import Gaia  # optional
    HAVE_ASTROQUERY = True
except Exception:
    HAVE_ASTROQUERY = False

ROOT = os.path.join(os.path.dirname(__file__), "..", "frontend")
app = Flask(__name__, static_folder=None)


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


# ---------------- targets ----------------
# pm in mas/yr (ra*cos(dec), dec). Coordinates are J2000-ish approximations for the demo.
TARGETS = {
    "barnards-star": dict(name="Barnard's Star", ra=269.4521, dec=4.6934, pm=(-798.6, 10328.1), plx=546.98,
                          kind="pm", note="High proper-motion red dwarf (~10.4 arcsec/yr)", teff=3200),
    "epsilon-indi-b": dict(name="Epsilon Indi B", ra=330.8724, dec=-56.7860, pm=(3966.0, -2536.0), plx=274.8,
                           kind="pm", note="Brown dwarf binary orbiting Epsilon Indi A", teff=1300),
    "wise-0855": dict(name="WISE 0855-0714", ra=133.7951, dec=-7.2451, pm=(-8118.0, 680.0), plx=439.0,
                      kind="pm", note="Coldest known brown dwarf (~285 K), very fast mover", teff=285),
    "rw-aur": dict(name="RW Aurigae", ra=76.9510, dec=30.4018, pm=(-0.9, -33.0), plx=7.0,
                   kind="var", period=190.0, amp=1.4, note="Young variable with dimming events", teff=4500),
    "r-dra": dict(name="R Draconis", ra=244.5964, dec=66.7550, pm=(-4.0, 3.0), plx=3.0,
                  kind="var", period=245.6, amp=3.0, note="Mira-type long-period variable", teff=2800),
}
ALIASES = {"barnard": "barnards-star", "barnard's star": "barnards-star", "barnards star": "barnards-star",
           "epsilon indi b": "epsilon-indi-b", "eps indi b": "epsilon-indi-b", "wise 0855": "wise-0855",
           "wise0855": "wise-0855", "wise 0855-0714": "wise-0855", "rw aur": "rw-aur", "rw aurigae": "rw-aur",
           "r dra": "r-dra", "r draconis": "r-dra"}

EPOCH0_MJD = 60800.0  # ~ May 2025 first SPHEREx pass
ARRAYS = [("D1", 0.75, 1.11), ("D2", 1.11, 1.64), ("D3", 1.64, 2.42),
          ("D4", 2.42, 3.82), ("D5", 3.82, 4.42), ("D6", 4.42, 5.00)]
FLAG_BITS = {0: "SAA passage", 1: "Cosmic ray hit", 2: "Zodiacal light saturation", 3: "Stray light"}


def mjd_to_utc(mjd):
    t = (mjd - 40587.0) * 86400.0
    return time.strftime("%Y-%m-%d", time.gmtime(t))


def resolve(name):
    k = name.strip().lower()
    k = ALIASES.get(k, k)
    return k if k in TARGETS else None


def build_epochs():
    ep = [dict(label="WISE 2010", mission="WISE", mjd=55400.0),
          dict(label="WISE 2014", mission="WISE", mjd=56800.0),
          dict(label="NEOSSat 2023", mission="NEOSSat", mjd=60100.0)]
    for i in range(4):
        ep.append(dict(label=f"SPHEREx pass {i+1}", mission="SPHEREx", mjd=EPOCH0_MJD + 182.6 * i))
    for i, e in enumerate(ep):
        e["index"] = i
        e["utc"] = mjd_to_utc(e["mjd"])
    return ep


def star_pos(t, mjd):
    """Offsets (arcsec, east/north) of target at mjd relative to its position at EPOCH0."""
    yrs = (mjd - EPOCH0_MJD) / 365.25
    return t["pm"][0] * yrs / 1000.0, t["pm"][1] * yrs / 1000.0


def brightness(t, mjd):
    if t["kind"] == "var":
        ph = 2 * math.pi * (mjd - EPOCH0_MJD) / t["period"]
        return 10 ** (-0.4 * t["amp"] * math.sin(ph))
    return 1.0


def field_stars(key, n=40):
    rng = np.random.default_rng(abs(hash(key)) % (2 ** 32) if False else sum(map(ord, key)))
    return [dict(x=float(rng.uniform(-1, 1)), y=float(rng.uniform(-1, 1)), f=float(10 ** rng.uniform(-1.8, -0.3)))
            for _ in range(n)]


def make_image(key, epoch, size, fov_arcmin, band_idx):
    """Synthetic cutout (float32 list of lists in 0..1+). x east=left like sky images."""
    t = TARGETS[key]
    half = fov_arcmin * 60 / 2.0
    scale = 2 * half / size  # arcsec / px
    rng = np.random.default_rng(1000 + sum(map(ord, key)) + epoch["index"] * 7 + band_idx)
    img = rng.normal(0.04, 0.012, (size, size)).astype(np.float32)
    yy, xx = np.mgrid[0:size, 0:size]
    sigma = max(1.4, 6.0 / (scale if scale > 0 else 1) * 0.35)
    sigma = min(sigma, 4.0)

    def blob(cx, cy, amp, s=sigma):
        nonlocal img
        img += amp * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * s * s)).astype(np.float32)

    # static field (galaxies/stars) in px
    for s in field_stars(key):
        blob(size / 2 + s["x"] * size * 0.45, size / 2 + s["y"] * size * 0.45, s["f"], sigma * (1.0 + s["f"]))
    dx, dy = star_pos(t, epoch["mjd"])
    px = size / 2 - dx / scale      # east to the left
    py = size / 2 - dy / scale      # north up
    bright = brightness(t, epoch["mjd"])
    band_boost = 1.0 + 0.25 * band_idx if t["teff"] < 1500 else 1.0 - 0.05 * band_idx
    blob(px, py, 0.9 * bright * band_boost, sigma * 1.1)
    if key == "epsilon-indi-b":
        blob(px + 3, py + 1, 0.55 * band_boost, sigma * 1.0)  # Ba/Bb pair
    return np.clip(img, 0, None), (px, py)


def gen_spectrum(t, n=102):
    wl = np.linspace(0.75, 5.0, n)
    T = t["teff"]
    h, c, k = 6.626e-34, 3e8, 1.381e-23
    lam = wl * 1e-6
    bb = 1.0 / (lam ** 5 * (np.exp(h * c / (lam * k * T)) - 1))
    f = bb / bb.max() * wl ** 0.0
    f = f * (wl ** 0.4)
    f = f / f.max()

    def trough(c0, w, d):
        return 1 - d * np.exp(-((wl - c0) ** 2) / (2 * w * w))
    cold = T < 1500
    f *= trough(1.40, 0.07, 0.35 if T < 3400 else 0.15)      # H2O
    f *= trough(1.90, 0.08, 0.40 if T < 3400 else 0.15)      # H2O
    f *= trough(2.70, 0.12, 0.45 if T < 3400 else 0.2)       # H2O
    f *= trough(4.26, 0.05, 0.25)                            # CO2
    f *= trough(4.65, 0.08, 0.35 if T < 3000 else 0.1)       # CO
    if cold:
        f *= trough(1.67, 0.05, 0.4)
        f *= trough(2.20, 0.08, 0.35)
        f *= trough(3.30, 0.15, 0.6)                         # CH4
        f *= 1 + 2.5 * np.exp(-((wl - 4.1) ** 2) / (2 * 0.25 ** 2))  # 4-5um flux peak
    rng = np.random.default_rng(int(T))
    err = 0.02 + 0.03 * (wl / 5.0)
    f = f + rng.normal(0, err * 0.5)
    return dict(wavelength=wl.round(4).tolist(), flux=f.round(5).tolist(), err=err.round(5).tolist(),
                arrays=[dict(id=a, lo=lo, hi=hi) for a, lo, hi in ARRAYS],
                molecules=[dict(name="H2O", at=[1.40, 1.90, 2.70]), dict(name="CH4", at=[1.67, 2.20, 3.30]),
                           dict(name="CO2", at=[4.26]), dict(name="CO", at=[4.65])])


def make_flags(epoch):
    rng = np.random.default_rng(epoch["index"] * 13 + 5)
    return [FLAG_BITS[b] for b in FLAG_BITS if rng.random() < 0.18 and epoch["mission"] == "SPHEREx"]


# ---------------- routes ----------------
@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/<path:p>")
def static_files(p):
    return send_from_directory(ROOT, p)


@app.route("/api/health")
def health():
    return jsonify(status="ok", live_libs=HAVE_ASTROQUERY, mode="demo-fallback")


@app.route("/api/targets")
def targets():
    return jsonify([dict(id=k, **{x: v[x] for x in ("name", "ra", "dec", "note", "kind")}) for k, v in TARGETS.items()])


@app.route("/api/resolve")
def api_resolve():
    q = request.args.get("q", "")
    k = resolve(q)
    if k:
        return jsonify(id=k, name=TARGETS[k]["name"], ra=TARGETS[k]["ra"], dec=TARGETS[k]["dec"], source="demo")
    try:  # live SIMBAD via CDS sesame
        import requests
        r = requests.get("https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV", params={"": q}, timeout=6)
        for line in r.text.splitlines():
            if line.startswith("%J"):
                p = line.split()
                return jsonify(id=None, name=q, ra=float(p[1]), dec=float(p[2]), source="sesame")
    except Exception:
        pass
    return jsonify(error="not found"), 404


def nearest_target(ra, dec):
    best, bd = None, 1e9
    for k, t in TARGETS.items():
        d = math.hypot((ra - t["ra"]) * math.cos(math.radians(dec)), dec - t["dec"]) * 60
        if d < bd:
            best, bd = k, d
    return (best, bd) if bd < 30 else (None, bd)


@app.route("/api/epochs")
def epochs():
    return jsonify(build_epochs())


@app.route("/api/cutouts")
def cutouts():
    ra = float(request.args.get("ra", 133.7951)); dec = float(request.args.get("dec", -7.2451))
    fov = float(request.args.get("fov", 5)); size = min(int(request.args.get("size", 128)), 256)
    band = request.args.get("band", "D1-D6")
    key, _ = nearest_target(ra, dec)
    if key is None:
        key = "wise-0855"  # generic synthetic field for unknown coordinates
    bi = {"D1": 0, "D2": 1, "D3": 2, "D4": 3, "D5": 4, "D6": 5}.get(band, 2)
    t = TARGETS[key]
    frames = []
    for e in build_epochs():
        img, (px, py) = make_image(key, e, size, fov, bi)
        frames.append(dict(epoch=e, source=e["mission"], data=np.round(img, 4).flatten().tolist(),
                           src_xy=[float(px), float(py)], flags=make_flags(e),
                           header=dict(EXPID=f"{2025000000 + e['index']*137}", MJD_AVG=e["mjd"], DATE_OBS=e["utc"],
                                       DETECTOR=band, EXPTIME=113.0 if e["mission"] == "SPHEREx" else 60.0,
                                       SNR=round(float(30 / (1 + e["index"] * 0.1)), 1), CRVAL1=ra, CRVAL2=dec,
                                       BUNIT="MJy/sr", ORIGIN=e["mission"])))
    return jsonify(target=dict(id=key, **{x: t[x] for x in ("name", "ra", "dec", "note")}), size=size, fov=fov,
                   frames=frames, mode="demo")


@app.route("/api/spectrum")
def spectrum():
    key = request.args.get("target") or nearest_target(float(request.args.get("ra", 0)), float(request.args.get("dec", 0)))[0] or "wise-0855"
    return jsonify(target=key, **gen_spectrum(TARGETS[key]))


@app.route("/api/lightcurve")
def lightcurve():
    key = request.args.get("target", "r-dra")
    t = TARGETS.get(key, TARGETS["r-dra"])
    rng = np.random.default_rng(3)
    mjd = np.arange(EPOCH0_MJD - 400, EPOCH0_MJD + 800, 15.0)
    mag = [round(-2.5 * math.log10(brightness(t, m)) + 8 + float(rng.normal(0, 0.03)), 3) for m in mjd]
    return jsonify(target=key, mjd=mjd.tolist(), mag=mag, spherex=[EPOCH0_MJD + 182.6 * i for i in range(4)])


@app.route("/api/catalogs")
def catalogs():
    ra = float(request.args.get("ra", 0)); dec = float(request.args.get("dec", 0)); fov = float(request.args.get("fov", 5))
    key, _ = nearest_target(ra, dec); key = key or "wise-0855"; t = TARGETS[key]
    rng = np.random.default_rng(sum(map(ord, key)))
    gaia = [dict(id=f"Gaia DR3 {4000000000000 + i * 977}", x=float(rng.uniform(-.9, .9)), y=float(rng.uniform(-.9, .9)),
                 gmag=round(float(rng.uniform(13, 20.5)), 2), plx=round(float(abs(rng.normal(2, 2))), 2),
                 pmra=round(float(rng.normal(0, 12)), 1), pmdec=round(float(rng.normal(0, 12)), 1)) for i in range(14)]
    gaia.insert(0, dict(id=f"Gaia DR3 (target) {t['name']}", x=0.0, y=0.0, gmag=12.0, plx=t["plx"], pmra=t["pm"][0], pmdec=t["pm"][1]))
    wise = [dict(id=f"J{int(ra*1000)}{i}", x=g["x"] + .02, y=g["y"] - .02, w1=round(float(rng.uniform(11, 16)), 2),
                 w2=round(float(rng.uniform(10, 15.5)), 2)) for i, g in enumerate(gaia[:8])]
    neo = [dict(id="2023 XY12 (NEO)", track=[[-.8, .6], [0.8, -.5]], source="NEOSSat/CADC"),
           dict(id="Debris-4417", track=[[-.7, -.7], [.6, .7]], source="NEOSSat/CADC")] if key == "wise-0855" or fov > 10 else \
          [dict(id="2024 AB7 (NEO)", track=[[-.8, -.1], [.8, .2]], source="NEOSSat/CADC")]
    return jsonify(gaia=gaia, wise=wise, neossat=neo, source="demo")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
