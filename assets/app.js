/* South Florida Overdose Tracker — standalone version.
   Loads the CSV/JSON files in ../data and draws everything with d3 v7. */
(function () {
  'use strict';

  // ---------- helpers ----------
  const fmtInt = d3.format(',');
  const fmtRate = d3.format('.1f');
  const parseM = d3.utcParse('%Y-%m');
  const monthLong = d3.utcFormat('%B %Y');
  const monthShort = d3.utcFormat('%b %Y');
  const num = (v) => (v === null || v === undefined || v === '' ? null : +v);
  const fmtChg = (v) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + d3.format('.1f')(Math.abs(v)) + '%');
  const fmt = (kind, v) => (v == null ? '—' : kind === 'int' ? fmtInt(v) : kind === 'rate' ? fmtRate(v) : kind === 'chg' ? fmtChg(v) : String(v));
  const SFL = ['12086', '12011', '12099'];
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const $ = (sel) => document.querySelector(sel);
  const setText = (sel, t) => { const el = $(sel); if (el) el.textContent = t; };
  const tractLabel = (tracts) => tracts.split(' ').map((t) => String(+t.slice(5, 9)) + (t.slice(9) === '00' ? '' : '.' + t.slice(9)));

  // ---------- data ----------
  const D = {};
  Promise.all([
    d3.csv('data/fl_overdose_deaths_12mo.csv'),
    d3.csv('data/fl_statewide_overdose_deaths_12mo.csv'),
    d3.csv('data/sfl_tract_group_overdose.csv'),
    d3.json('data/sfl_tract_groups.json'),
    d3.json('data/sfl_counties.json'),
    d3.csv('data/sfl_otp_sites.csv'),
    d3.csv('data/sfl_tract_group_methadone_distance.csv'),
    d3.csv('data/sfl_naloxone_sites.csv'),
  ]).then(([county, state, tract, geo, cty, otp, dist, nx]) => {
    Object.assign(D, { county, state, tract, geo, cty, otp, dist, nx });
    derive();
    renderAll();
    let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { renderMap(); renderTrend(); }, 150); });
  }).catch((err) => {
    console.error(err);
    document.querySelectorAll('.loading').forEach((el) => { el.textContent = 'Failed to load data files. If you opened index.html directly from your computer, use a web server (see README).'; });
  });

  // ---------- derived values (same formulas as the Claude dashboard) ----------
  function derive() {
    // latest 12 months by county
    const months = [...new Set(D.county.map((r) => r.month_ending))].sort();
    const latest = months[months.length - 1], prior = months[months.length - 13];
    D.countyLatest = [...d3.group(D.county, (r) => r.fips)].map(([fips, rows]) => {
      const now = rows.find((r) => r.month_ending === latest), then = rows.find((r) => r.month_ending === prior);
      const deaths = now ? num(now.deaths_12mo) : null, deaths_prior = then ? num(then.deaths_12mo) : null, population = now ? +now.population : null;
      return { fips, county: now.county, urbanicity: now.urbanicity, month_ending: latest, deaths, deaths_prior, population,
        rate: deaths == null ? null : Math.round((deaths / population) * 1e6) / 10,
        change_pct: deaths == null || !deaths_prior ? null : Math.round(((deaths - deaths_prior) / deaths_prior) * 1000) / 10 };
    });
    // South Florida summary
    const rows = SFL.map((f) => D.countyLatest.find((r) => r.fips === f)).filter(Boolean);
    const deaths = d3.sum(rows, (r) => r.deaths), deaths_prior = d3.sum(rows, (r) => r.deaths_prior), population = d3.sum(rows, (r) => r.population);
    D.sflSummary = [{ area: 'South Florida', deaths, deaths_prior, population,
      rate: Math.round((deaths / population) * 1e6) / 10, change_pct: Math.round(((deaths - deaths_prior) / deaths_prior) * 1000) / 10 }, ...rows];
    // monthly rates
    D.ratesMonthly = D.county.map((r) => { const d = num(r.deaths_12mo); return { fips: r.fips, county: r.county, month_ending: r.month_ending, deaths: d, rate: d == null ? null : Math.round((d / +r.population) * 1e6) / 10 }; });
    D.stateRates = D.state.map((r) => ({ month_ending: r.month_ending, deaths: +r.deaths_12mo_reported, rate: Math.round((+r.deaths_12mo_reported / +r.population) * 1e6) / 10 }));
    // South Florida benchmark for map periods
    const sflRows = D.county.filter((r) => SFL.includes(r.fips));
    const pick = [['2022', '2022-12'], ['2023', '2023-12'], ['2024', '2024-12'], ['Latest 12 months', latest]];
    D.sflPeriod = pick.map(([period, m]) => { const rr = sflRows.filter((r) => r.month_ending === m); const dd = d3.sum(rr, (r) => +r.deaths_12mo), pp = d3.sum(rr, (r) => +r.population); return { period, rate: Math.round((dd / pp) * 1e6) / 10 }; });
    const ref = new Map(D.sflPeriod.map((r) => [r.period, r.rate]));
    // tract rates with intervals
    const byar = (d, z) => [d === 0 ? 0 : d * Math.pow(1 - 1 / (9 * d) - z / (3 * Math.sqrt(d)), 3), (d + 1) * Math.pow(1 - 1 / (9 * (d + 1)) + z / (3 * Math.sqrt(d + 1)), 3)];
    D.tractRates = D.tract.map((r) => {
      const rate = num(r.rate), dth = num(r.deaths);
      let lo = num(r.ci_low), hi = num(r.ci_high);
      if (dth != null && dth >= 10 && rate) { const pop = (dth / rate) * 1e5; const [a, b] = byar(dth, 1.96); lo = Math.round((a / pop) * 1e6) / 10; hi = Math.round((b / pop) * 1e6) / 10; }
      const sfl = ref.has(r.period) ? ref.get(r.period) : null;
      return { group: r.group, county: r.county, period: r.period, period_order: +r.period_order, deaths: dth, deaths_label: r.deaths_label, rate,
        modeled: r.modeled === 'yes', ci_low: lo, ci_high: hi, ci_text: lo == null ? '—' : `${lo.toFixed(1)}–${hi.toFixed(1)}`,
        sfl_rate: sfl, above_sfl: lo != null && sfl != null && lo > sfl, tract_count: +r.tract_count, tracts: r.tracts };
    });
    D.distByGroup = new Map(D.dist.map((r) => [r.group, r]));
  }

  function renderAll() {
    renderHeadline(); renderTiles(); renderCountyPick(); renderCountyTable();
    renderMap(); renderHover(); renderDetail(); renderTrend();
  }

  // ---------- headline & tiles ----------
  function renderHeadline() {
    const s = D.sflSummary[0];
    setText('#latest-month', monthLong(parseM(D.countyLatest[0].month_ending)));
    setText('#sfl-deaths', fmtInt(s.deaths));
    setText('#sfl-dir', s.change_pct < 0 ? 'down' : s.change_pct > 0 ? 'up' : 'unchanged,');
    setText('#sfl-change', d3.format('.1f')(Math.abs(s.change_pct)) + '%');
  }
  function renderTiles() {
    const win = monthShort(parseM(D.countyLatest[0].month_ending));
    document.querySelectorAll('#tiles .card').forEach((card) => {
      const r = D.sflSummary[+card.dataset.row]; if (!r) return;
      card.querySelector('.win').textContent = win;
      card.querySelector('.v-deaths').textContent = fmt('int', r.deaths);
      card.querySelector('.v-rate').textContent = fmt('rate', r.rate);
      const c = card.querySelector('.v-chg'); c.textContent = fmtChg(r.change_pct);
      c.style.color = r.change_pct < 0 ? css('--ok') : r.change_pct > 0 ? css('--bad') : '';
      card.querySelector('.v-prior').textContent = fmt('int', r.deaths_prior);
    });
  }

  // ---------- county table ----------
  let sortKey = 'rate';
  $('#sort').addEventListener('change', (e) => { sortKey = e.target.value; renderCountyTable(); });
  function renderCountyTable() {
    const tb = $('#county-rows'); tb.replaceChildren();
    const rows = D.countyLatest.slice().sort((a, b) => {
      if (sortKey === 'county') return d3.ascending(a.county, b.county);
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return d3.ascending(a.county, b.county);
      if (av == null) return 1; if (bv == null) return -1;
      return d3.descending(av, bv);
    });
    rows.forEach((r) => {
      const tr = document.createElement('tr'); if (SFL.includes(r.fips)) tr.className = 'sfl';
      [[r.county, ''], [r.deaths == null ? 'suppressed' : fmtInt(r.deaths), r.deaths == null ? 'muted' : ''], [r.rate == null ? '—' : fmtRate(r.rate), ''],
        [r.deaths_prior == null ? 'suppressed' : fmtInt(r.deaths_prior), r.deaths_prior == null ? 'muted' : ''], [fmtChg(r.change_pct), ''], [r.urbanicity, 'l muted']]
        .forEach(([t, c], i) => {
          const td = document.createElement('td'); td.textContent = t; if (c) td.className = c;
          if (i === 4 && r.change_pct != null) td.style.color = r.change_pct < 0 ? css('--ok') : r.change_pct > 0 ? css('--bad') : '';
          tr.appendChild(td);
        });
      tb.appendChild(tr);
    });
  }

  // ---------- trend chart ----------
  let pickFips = '';
  function renderCountyPick() {
    const sel = $('#county-pick');
    const rows = D.countyLatest.filter((r) => !SFL.includes(r.fips) && r.deaths != null).sort((a, b) => d3.ascending(a.county, b.county));
    sel.replaceChildren(new Option('None', ''), ...rows.map((r) => new Option(r.county, r.fips)));
    sel.value = pickFips;
    sel.onchange = () => { pickFips = sel.value; renderTrend(); };
  }
  function renderTrend() {
    const el = $('#trend-chart');
    const series = [
      { key: '12086', name: 'Miami-Dade', color: css('--s1') },
      { key: '12011', name: 'Broward', color: css('--s2') },
      { key: '12099', name: 'Palm Beach', color: css('--s3') },
    ];
    if (pickFips && !SFL.includes(pickFips)) { const any = D.ratesMonthly.find((r) => r.fips === pickFips); if (any) series.push({ key: pickFips, name: any.county, color: css('--s4') }); }
    series.forEach((s) => { s.points = D.ratesMonthly.filter((r) => r.fips === s.key).map((r) => ({ date: parseM(r.month_ending), rate: r.rate, deaths: r.deaths })).sort((a, b) => a.date - b.date); });
    series.push({ key: 'FL', name: 'Florida', color: css('--ref'), dashed: true, points: D.stateRates.map((r) => ({ date: parseM(r.month_ending), rate: r.rate, deaths: r.deaths })).sort((a, b) => a.date - b.date) });

    const W = Math.max(280, el.clientWidth), H = W < 500 ? 280 : 360;
    const all = series.flatMap((s) => s.points.filter((p) => p.rate != null));
    const x = d3.scaleUtc().domain(d3.extent(all, (p) => p.date));
    const y = d3.scaleLinear().domain([0, d3.max(all, (p) => p.rate) * 1.08]).nice();
    el.replaceChildren();
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('height', H).attr('viewBox', `0 0 ${W} ${H}`)
      .attr('role', 'img').attr('aria-label', 'Rolling 12-month overdose death rate per 100,000 by county and statewide');
    const probe = svg.append('g');
    let yw = 0; y.ticks(5).forEach((t) => { yw = Math.max(yw, probe.append('text').text(t).node().getComputedTextLength()); });
    let lw = 0; series.forEach((s) => { lw = Math.max(lw, probe.append('text').attr('class', 'endlabel').text(s.name).node().getComputedTextLength()); });
    probe.remove();
    const narrow = W < 520;
    const m = { top: 12, right: narrow ? 12 : lw + 14, bottom: 28, left: yw + 36 };
    x.range([m.left, W - m.right]); y.range([H - m.bottom, m.top]);
    svg.append('text').attr('class', 'axis-title').attr('transform', `translate(13,${(m.top + H - m.bottom) / 2}) rotate(-90)`)
      .attr('text-anchor', 'middle').attr('dy', '0.35em').text(narrow ? 'Deaths per 100,000' : 'Overdose deaths per 100,000 residents (rolling 12 months)')
      .each(function () { if (this.getComputedTextLength() > H - m.top - m.bottom) this.textContent = 'Deaths per 100,000 residents'; });
    svg.append('g').attr('transform', `translate(0,${H - m.bottom})`).call(d3.axisBottom(x).ticks(narrow ? 4 : 7).tickSizeOuter(0))
      .call((g) => g.select('.domain').attr('stroke', css('--axis'))).call((g) => g.selectAll('line').attr('stroke', css('--axis')));
    svg.append('g').attr('transform', `translate(${m.left},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.left - m.right)))
      .call((g) => g.select('.domain').remove()).call((g) => g.selectAll('line').attr('stroke', css('--grid')));
    const line = d3.line().defined((p) => p.rate != null).x((p) => x(p.date)).y((p) => y(p.rate));
    svg.append('g').selectAll('path').data(series).join('path').attr('fill', 'none').attr('stroke-width', (s) => (s.dashed ? 1.5 : 2.2))
      .attr('stroke-dasharray', (s) => (s.dashed ? '4 3' : null)).attr('stroke', (s) => s.color).attr('d', (s) => line(s.points));
    if (!narrow) {
      const ends = series.map((s) => { const last = s.points.filter((p) => p.rate != null).pop(); return last ? { s, y: y(last.rate) } : null; }).filter(Boolean).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
      svg.append('g').selectAll('text').data(ends).join('text').attr('class', 'endlabel').attr('x', W - m.right + 6).attr('y', (e) => e.y)
        .attr('dy', '0.35em').style('fill', (e) => e.s.color).text((e) => e.s.name);
    } else {
      const lg = d3.select(el).append('div').attr('class', 'controls');
      series.forEach((s) => { const it = lg.append('span'); it.append('span').attr('class', 'sw').style('background', s.color); it.append('span').text(s.name); });
    }
    const tip = d3.select(el).append('div').attr('class', 'tip').style('display', 'none');
    const guide = svg.append('line').attr('y1', m.top).attr('y2', H - m.bottom).attr('stroke', css('--axis')).style('display', 'none');
    const months = [...new Set(all.map((p) => +p.date))].sort((a, b) => a - b).map((t) => new Date(t));
    function show(px) {
      const dt = months[d3.bisector((d) => d).center(months, x.invert(px))]; if (!dt) return;
      guide.attr('x1', x(dt)).attr('x2', x(dt)).style('display', null);
      tip.style('display', null).selectAll('*').remove();
      tip.append('div').attr('class', 'tip-head').text('12 months ending ' + monthShort(dt));
      series.forEach((s) => {
        const p = s.points.find((q) => +q.date === +dt);
        const r = tip.append('div').attr('class', 'row');
        const l = r.append('span'); l.append('span').attr('class', 'sw').style('background', s.color); l.append('span').text(s.name);
        r.append('span').text(p && p.rate != null ? `${fmtRate(p.rate)} · ${fmtInt(p.deaths)}` : 'n/a');
      });
      const tw = tip.node().offsetWidth;
      tip.style('left', Math.max(0, x(dt) + 12 + tw > W ? x(dt) - tw - 12 : x(dt) + 12) + 'px').style('top', m.top + 'px');
    }
    svg.append('rect').attr('x', m.left).attr('y', m.top).attr('width', W - m.left - m.right).attr('height', H - m.top - m.bottom).attr('fill', 'transparent')
      .on('pointermove', (ev) => show(d3.pointer(ev)[0])).on('pointerleave', () => { tip.style('display', 'none'); guide.style('display', 'none'); });
  }

  // ---------- map ----------
  const state = { period: 'Latest 12 months', county: '', modeled: true, above: false, counties: true, mm: true, otp: false, nx: true, selected: null, hoverGroup: null, zoom: null, zoomW: 0 };
  const BREAKS = [5, 10, 15, 20, 30, 50];
  const PALETTE = ['#3b302a', '#5e3b24', '#8b4a1f', '#b8581a', '#e06c1c', '#f59a3c', '#ffd08a'];
  const NA_FILL = '#2c2b28';
  const color = d3.scaleThreshold().domain(BREAKS).range(PALETTE);
  const bind = (sel, fn) => $(sel).addEventListener('change', (e) => fn(e.target));
  bind('#map-period', (el) => { state.period = el.value; renderMap(); renderHover(); });
  bind('#map-county', (el) => { state.county = el.value; state.zoom = null; renderMap(); });
  bind('#tog-modeled', (el) => { state.modeled = el.checked; renderMap(); renderHover(); });
  bind('#tog-above', (el) => { state.above = el.checked; renderMap(); });
  bind('#tog-county', (el) => { state.counties = el.checked; renderMap(); });
  bind('#tog-mm', (el) => { state.mm = el.checked; renderMap(); });
  bind('#tog-otp', (el) => { state.otp = el.checked; renderMap(); });
  bind('#tog-nx', (el) => { state.nx = el.checked; renderMap(); });

  const SITE_TYPES = {
    'Health department clinic': { badge: 'Health department clinic', what: 'County health department clinic. Ask staff for a free naloxone kit during clinic hours (adults 18+).' },
    'Community distributor': { badge: 'Community organization', what: 'Local organization that hands out free naloxone kits and overdose training. Call ahead for hours.' },
    'Vending machine (jail lobby)': { badge: 'Jail-lobby vending machine', what: 'Free naloxone vending machine in the public lobby of a county jail. No questions asked; available when the lobby is open.' },
    'Narcan cabinet': { badge: 'Emergency Narcan cabinet', what: 'Wall-mounted emergency cabinet for grabbing Narcan during an overdose. Some are inside recovery residences or housing and may be for residents only.' },
    Methadone: { badge: 'Methadone clinic', what: 'Outpatient opioid treatment program offering ongoing methadone (and buprenorphine) maintenance for opioid use disorder, usually with daily dosing visits.' },
    Other: { badge: 'Detox / residential program', what: 'Federally certified treatment program focused on detox, residential or inpatient care. Uses medication mainly for withdrawal, not long-term maintenance.' },
  };

  function renderMap() {
    const el = $('#tract-map');
    const rows = new Map(D.tractRates.filter((r) => r.period === state.period).map((r) => [r.group, r]));
    const feats = D.geo.features.filter((f) => !state.county || (rows.get(f.properties.group) || {}).county === state.county);
    const W = Math.max(280, el.clientWidth);
    const H = Math.min(780, Math.round(W * (state.county === 'Broward' || state.county === 'Palm Beach' ? 0.85 : 1.25)));
    const proj = d3.geoMercator().fitExtent([[8, 8], [W - 8, H - 8]], { type: 'FeatureCollection', features: feats });
    const path = d3.geoPath(proj);
    el.replaceChildren();
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('height', H).attr('viewBox', `0 0 ${W} ${H}`)
      .attr('role', 'img').attr('aria-label', `Overdose death rate per 100,000 by tract group, ${state.period}`);
    const g = svg.append('g');
    const fillFor = (r) => (!r || r.rate == null || (r.modeled && !state.modeled) ? NA_FILL : color(r.rate));
    const tip = d3.select(el).append('div').attr('class', 'tip').style('display', 'none');

    g.append('g').selectAll('path').data(feats).join('path')
      .attr('d', path).attr('fill', (f) => fillFor(rows.get(f.properties.group)))
      .attr('stroke', '#191816').attr('stroke-width', 0.5).attr('vector-effect', 'non-scaling-stroke').style('cursor', 'pointer')
      .on('pointermove', (ev, f) => hoverArea(rows.get(f.properties.group)))
      .on('click', (ev, f) => { state.selected = f.properties.group; renderDetail(); renderMap(); });

    if (state.above) {
      g.append('g').selectAll('path').data(feats.filter((f) => { const r = rows.get(f.properties.group); return r && r.above_sfl && (state.modeled || !r.modeled); }))
        .join('path').attr('d', path).attr('fill', 'none').attr('stroke', css('--fg')).attr('stroke-width', 1.8).attr('vector-effect', 'non-scaling-stroke').style('pointer-events', 'none');
    }
    let ctyLabels = null;
    if (state.counties) {
      const cf = D.cty.features.filter((f) => !state.county || f.properties.county === state.county);
      const cg = g.append('g').style('pointer-events', 'none');
      cg.selectAll('path.halo').data(cf).join('path').attr('class', 'halo').attr('d', path).attr('fill', 'none').attr('stroke', '#111')
        .attr('stroke-width', 5).attr('stroke-linejoin', 'round').attr('vector-effect', 'non-scaling-stroke').style('opacity', 0.8);
      cg.selectAll('path.cline').data(cf).join('path').attr('class', 'cline').attr('d', path).attr('fill', 'none').attr('stroke', '#e9e6dc')
        .attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('vector-effect', 'non-scaling-stroke');
      const anchor = { 'Palm Beach': [-80.16, 26.66], Broward: [-80.24, 26.13], 'Miami-Dade': [-80.37, 25.68] };
      ctyLabels = cg.selectAll('text.clabel').data(cf).join('text').attr('class', 'clabel')
        .attr('x', (f) => proj(anchor[f.properties.county] || d3.geoCentroid(f))[0]).attr('y', (f) => proj(anchor[f.properties.county] || d3.geoCentroid(f))[1])
        .attr('text-anchor', 'middle').style('fill', '#f3f1ea').style('font-weight', 600).style('font-size', '13px').style('letter-spacing', '0.06em')
        .style('paint-order', 'stroke').attr('stroke', '#111').attr('stroke-width', 3).attr('stroke-linejoin', 'round')
        .text((f) => f.properties.county.toUpperCase());
    }
    if (state.selected) {
      const sf = feats.find((f) => f.properties.group === state.selected);
      if (sf) g.append('path').attr('d', path(sf)).attr('fill', 'none').attr('stroke', css('--s2')).attr('stroke-width', 2.8).attr('vector-effect', 'non-scaling-stroke').style('pointer-events', 'none');
    }
    const hoverLine = g.append('path').attr('fill', 'none').attr('stroke', '#ffffff').attr('stroke-width', 2.5).attr('vector-effect', 'non-scaling-stroke')
      .style('pointer-events', 'none').style('display', 'none');

    // treatment programs
    const sites = D.otp.filter((s) => (!state.county || s.county === state.county) && (s.category.startsWith('Methadone') ? state.mm : state.otp))
      .sort((a, b) => (a.category < b.category ? 1 : -1));
    const pts = g.append('g').attr('class', 'sites').selectAll('circle').data(sites).join('circle')
      .attr('cx', (s) => proj([+s.lon, +s.lat])[0]).attr('cy', (s) => proj([+s.lon, +s.lat])[1]).attr('r', 6)
      .attr('fill', (s) => (s.category.startsWith('Methadone') ? css('--mm') : css('--bg'))).attr('stroke', (s) => (s.category.startsWith('Methadone') ? '#ffffff' : css('--mm')))
      .attr('stroke-width', (s) => (s.category.startsWith('Methadone') ? 1.5 : 2)).attr('vector-effect', 'non-scaling-stroke')
      .on('pointerenter pointermove click', (ev, s) => { ev.stopPropagation(); showSiteTip(ev, s); })
      .on('pointerleave', () => tip.style('display', 'none'));
    // naloxone sites
    const nxSites = state.nx ? D.nx.filter((s) => !state.county || s.county === state.county) : [];
    const diamond = d3.symbol().type(d3.symbolDiamond).size(120)();
    const nxPos = (s) => proj([+s.lon, +s.lat]);
    const nxPts = g.append('g').attr('class', 'nx').selectAll('path').data(nxSites).join('path')
      .attr('d', diamond).attr('transform', (s) => `translate(${nxPos(s)[0]},${nxPos(s)[1]})`)
      .attr('fill', css('--nx')).attr('stroke', '#ffffff').attr('stroke-width', 1.2).attr('vector-effect', 'non-scaling-stroke')
      .on('pointerenter pointermove click', (ev, s) => { ev.stopPropagation(); showNxTip(ev, s); })
      .on('pointerleave', () => tip.style('display', 'none'));

    // zoom
    const zoom = d3.zoom().scaleExtent([1, 14]).translateExtent([[0, 0], [W, H]]).on('zoom', (ev) => {
      const k = ev.transform.k;
      g.attr('transform', ev.transform); state.zoom = ev.transform;
      pts.attr('r', 6 / Math.sqrt(k));
      nxPts.attr('transform', (s) => `translate(${nxPos(s)[0]},${nxPos(s)[1]}) scale(${1 / Math.sqrt(k)})`);
      if (ctyLabels) ctyLabels.style('font-size', `${13 / k}px`).attr('stroke-width', 3 / k);
    });
    svg.call(zoom);
    if (state.zoom && state.zoomW === W) svg.call(zoom.transform, state.zoom); else state.zoom = null;
    state.zoomW = W;

    // legend
    const lg = svg.append('g').attr('transform', `translate(12, ${H - 44})`);
    const sw = Math.min(34, (W - 40) / 8);
    lg.append('rect').attr('x', -6).attr('y', -20).attr('width', 8 * sw + 18).attr('height', 52).attr('rx', 6).attr('fill', 'rgba(25,24,22,.75)');
    ['<5', '5', '10', '15', '20', '30', '50+'].forEach((t, i) => {
      lg.append('rect').attr('x', i * sw).attr('y', 0).attr('width', sw - 2).attr('height', 10).attr('fill', PALETTE[i]).attr('stroke', css('--border'));
      lg.append('text').attr('x', i * sw).attr('y', 24).text(t);
    });
    lg.append('rect').attr('x', 7 * sw + 6).attr('y', 0).attr('width', sw - 2).attr('height', 10).attr('fill', NA_FILL).attr('stroke', css('--border'));
    lg.append('text').attr('x', 7 * sw + 6).attr('y', 24).text('n/a');
    lg.append('text').attr('x', 0).attr('y', -6).style('fill', css('--fg')).text('Deaths per 100,000');

    function hoverArea(r) {
      if (!r) return;
      const f = feats.find((x) => x.properties.group === r.group);
      if (f) hoverLine.attr('d', path(f)).style('display', null);
      if (state.hoverGroup === r.group) return;
      state.hoverGroup = r.group; renderHover();
    }
    svg.on('pointerleave', () => { hoverLine.style('display', 'none'); if (state.hoverGroup) { state.hoverGroup = null; renderHover(); } });

    function placeTip(ev) {
      const [x, y] = d3.pointer(ev, el);
      const tw = tip.node().offsetWidth, th = tip.node().offsetHeight;
      tip.style('left', Math.max(0, x + 14 + tw > W ? x - tw - 14 : x + 14) + 'px').style('top', Math.max(0, y + th + 10 > H ? y - th - 10 : y - 10) + 'px');
    }
    function tipHeader(name, badge, c, hollow) {
      tip.style('display', null).selectAll('*').remove();
      const b = tip.append('div').attr('class', 'tip-badge');
      b.append('span').attr('class', 'tip-sw').style('background', hollow ? 'transparent' : c).style('border-color', c);
      b.append('span').text(badge);
      tip.append('div').attr('class', 'tip-head').text(name);
    }
    function showNxTip(ev, s) {
      const t = SITE_TYPES[s.category] || { badge: s.category, what: '' };
      tipHeader(s.name, t.badge, css('--nx'), false);
      tip.append('div').attr('class', 'tip-what').text(t.what);
      tip.append('div').attr('class', 'line').text(`${s.street}, ${s.city} ${s.zip}`);
      if (s.access_note) tip.append('div').attr('class', 'line').text(s.access_note);
      if (s.location_precision === 'approximate') tip.append('div').attr('class', 'line').text('Map position is approximate (street only).');
      tip.append('div').attr('class', 'tip-src').text(`Source: ${s.source}. List checked ${s.list_checked}.`);
      placeTip(ev);
    }
    function showSiteTip(ev, s) {
      const mm = s.category.startsWith('Methadone');
      const t = SITE_TYPES[mm ? 'Methadone' : 'Other'];
      tipHeader(s.name, t.badge, css('--mm'), !mm);
      tip.append('div').attr('class', 'tip-what').text(t.what);
      tip.append('div').attr('class', 'line').text(`${s.street}, ${s.city} ${s.zip}`);
      const row = (k, v) => { const d = tip.append('div').attr('class', 'row'); d.append('span').text(k); d.append('span').text(v); };
      row('Accepts Medicaid', s.accepts_medicaid === 'yes' ? 'Yes' : 'Not listed');
      if (s.phone) row('Phone', s.phone);
      tip.append('div').attr('class', 'tip-src').text('Source: SAMHSA FindTreatment.gov, checked 2026-11-13.');
      placeTip(ev);
    }
  }

  // ---------- side panels ----------
  function renderHover() {
    const box = d3.select('#hover-body');
    box.selectAll('*').remove();
    const r = state.hoverGroup ? D.tractRates.find((x) => x.group === state.hoverGroup && x.period === state.period) : null;
    if (!r) { box.text('—'); return; }
    box.text('');
    const head = box.append('div').attr('class', 'hover-head');
    const shaded = r.rate != null && (state.modeled || !r.modeled);
    head.append('span').attr('class', 'hover-sw').style('background', shaded ? color(r.rate) : NA_FILL);
    const tl = tractLabel(r.tracts);
    head.append('span').text(`${r.county} · tract${tl.length > 1 ? 's' : ''} ${tl.join(', ')}`);
    const row = (k, v) => { const d = box.append('div').attr('class', 'row'); d.append('span').attr('class', 'muted').text(k); d.append('span').text(v); };
    row('Period', r.period);
    row('Deaths', r.deaths_label);
    row('Rate per 100,000', r.rate == null ? 'not estimated' : fmtRate(r.rate) + (r.modeled ? ' (modeled)' : ''));
    row('95% interval', r.ci_text);
    if (r.sfl_rate != null) row('South Florida rate', fmtRate(r.sfl_rate));
    const near = D.distByGroup.get(r.group);
    if (near) row('Nearest methadone clinic', `${(+near.miles_to_nearest_methadone).toFixed(1)} mi`);
    if (r.above_sfl) box.append('div').attr('class', 'flag').text('Significantly above the South Florida rate');
  }
  function renderDetail() {
    setText('#sfl-ref', D.sflPeriod.map((r) => `${r.period === 'Latest 12 months' ? 'latest' : r.period} ${fmtRate(r.rate)}`).join(' · '));
    const tb = $('#detail-rows'); tb.replaceChildren();
    if (!state.selected) { setText('#detail-note', '—'); setText('#mm-miles', '—'); setText('#mm-name', '—'); return; }
    const rows = D.tractRates.filter((r) => r.group === state.selected).sort((a, b) => a.period_order - b.period_order);
    if (!rows.length) return;
    setText('#detail-note', `${rows[0].county} — census tracts ${tractLabel(rows[0].tracts).join(', ')}`);
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      [r.period, r.deaths_label, r.rate == null ? 'n/a' : fmtRate(r.rate) + (r.modeled ? '*' : ''), r.ci_text].forEach((v, i) => {
        const td = document.createElement('td'); td.textContent = v; if (i === 0) td.className = 'l';
        if (i === 2 && r.above_sfl) td.style.color = css('--bad');
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    const near = D.distByGroup.get(state.selected);
    setText('#mm-miles', near ? (+near.miles_to_nearest_methadone).toFixed(1) : '—');
    setText('#mm-name', near ? near.nearest_methadone_site : '—');
  }
})();
