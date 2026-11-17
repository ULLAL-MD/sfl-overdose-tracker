# South Florida Overdose Tracker (standalone site)

A static website with no server code. It shows drug overdose deaths in Miami-Dade, Broward and Palm Beach counties: county trends, a neighborhood map, methadone clinics and free naloxone sites. Data comes from public CDC, Census, SAMHSA and Hanley Foundation sources. The site is a snapshot of dashboard version 50 (17 Nov 2026).

## Folder contents

```
index.html          page layout and text
assets/style.css    dark theme
assets/app.js       charts, map, tables (d3)
assets/d3.v7.min.js d3 library, bundled so the site needs no outside CDN
data/               the 8 data files the page reads
```

## Put it online

**Option A: Netlify Drop (about 1 minute, no account needed to try)**
1. Go to https://app.netlify.com/drop
2. Drag the whole `sfl-overdose-tracker` folder onto the page.
3. Netlify gives you a public link. Create a free account to keep the site and rename the link.
4. To update it later, open the site in Netlify, go to Deploys, and drag the updated folder in again.

**Option B: GitHub Pages (free, keeps version history)**
1. Create a new public repository on github.com.
2. Choose "uploading an existing file" and drag in the *contents* of this folder (index.html, assets, data, README.md). Commit.
3. Go to Settings → Pages. Under Source, pick "Deploy from a branch", choose `main` and `/ (root)`, then Save.
4. The site appears at `https://<your-username>.github.io/<repo-name>/` within a few minutes.
5. Each later upload is saved as a commit, so every version stays recoverable.

**Viewing it on your own computer:** double-clicking index.html won't work, because browsers block local data loading. In a terminal inside this folder, run `python3 -m http.server`, then open http://localhost:8000.

## Quarterly update

Replace the files in `data/` with new versions that keep the same column names, then redeploy. No code changes are needed.

| File | Source | Refresh |
|---|---|---|
| fl_overdose_deaths_12mo.csv | CDC VSRR county provisional counts (data.cdc.gov `gb4e-yj24`) | monthly |
| fl_statewide_overdose_deaths_12mo.csv | CDC VSRR state counts (`xkb8-kh2a`) | monthly |
| sfl_tract_group_overdose.csv | CDC tract-level overdose data (`4day-mt2f`) | as CDC releases |
| sfl_otp_sites.csv, sfl_tract_group_methadone_distance.csv | SAMHSA FindTreatment.gov | quarterly |
| sfl_naloxone_sites.csv | FDOH / Hanley Foundation naloxone lists | quarterly |
| sfl_tract_groups.json, sfl_counties.json | Census 2020 boundaries | not needed |

Two text items need editing by hand at each update: the "Data as of" line and the source dates in the footer of `index.html`. Death counts, rates, the latest month and all percent changes are calculated from the data files automatically.

## Caveats

- Counts are provisional and by county of **residence**.
- Counts of 1 to 9 are suppressed by CDC.
- Tract rates marked "modeled" are CDC estimates.
- Distance to the nearest methadone clinic is a straight-line distance, not travel time.
