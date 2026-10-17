/* AetherX route desk — prototype
   Routing: OSRM public server · Geocoding: Nominatim · Chargers: Overpass (all OpenStreetMap)
   Everything else runs in the browser. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------------------------------------------------------------- vehicle model
// base: kg CO2 per km at the most efficient cruising speed
// unit/perUnit: what is burned, and kg CO2 per unit of it
const VEHICLES = {
  petrol: { name: 'Petrol hatchback', base: 0.138, unit: 'L',   perUnit: 2.31, price: 102, lowK: 1.1, highK: 0.9 },
  diesel: { name: 'Diesel SUV',       base: 0.172, unit: 'L',   perUnit: 2.68, price: 90,  lowK: 1.0, highK: 1.0 },
  cng:    { name: 'CNG sedan',        base: 0.112, unit: 'kg',  perUnit: 2.75, price: 76,  lowK: 1.0, highK: 0.9 },
  ev:     { name: 'Electric (EV)',    base: 0.092, unit: 'kWh', perUnit: 0.71, price: 9,   lowK: 0.35, highK: 1.1 },
  lcv:    { name: 'Light delivery van', base: 0.205, unit: 'L', perUnit: 2.68, price: 90,  lowK: 1.2, highK: 1.0 },
};
const BEST_SPEED = 60;

function speedCurve(v, veh) {
  v = Math.max(5, Math.min(130, v));
  const d = (v - BEST_SPEED) / BEST_SPEED;
  return 1 + (v < BEST_SPEED ? veh.lowK : veh.highK) * d * d;
}
function stopPenalty(km) {
  if (km < 0.4) return 1.18;
  if (km < 1) return 1.10;
  if (km < 3) return 1.04;
  return 1;
}
// Typical-traffic model. OSRM durations assume empty roads, so we slow each step
// down by how congested roads of that free-flow speed usually are at that hour.
const TRAFFIC = {
  peak:  { label: 'Peak hour', f: [1.35, 1.95, 1.6, 1.15] },
  day:   { label: 'Daytime',   f: [1.15, 1.35, 1.25, 1.05] },
  night: { label: 'Night',     f: [1, 1, 1, 1] },
};
function periodNow() {
  const h = new Date().getHours();
  return (h >= 8 && h < 11) || (h >= 17 && h < 21) ? 'peak' : h >= 21 || h < 6 ? 'night' : 'day';
}
function congestion(freeV, period) {
  const f = TRAFFIC[period].f;
  return freeV < 25 ? f[0] : freeV < 45 ? f[1] : freeV < 70 ? f[2] : f[3];
}

function stepCO2(km, sec, veh) {
  const v = sec > 0 ? km / (sec / 3600) : BEST_SPEED;
  return km * veh.base * speedCurve(v, veh) * stopPenalty(km);
}

// ---------------------------------------------------------------- state
const S = {
  vehicle: 'petrol',
  period: 'peak', // demo default; periodNow() picks from the clock
  from: null, to: null,
  routes: [], sel: 0,
  drive: null,
  trips: loadTrips(),
};

function loadTrips() {
  try { return JSON.parse(localStorage.getItem('aetherx.trips') || '[]'); } catch { return []; }
}
function saveTrips() {
  try { localStorage.setItem('aetherx.trips', JSON.stringify(S.trips)); } catch {}
}

// ---------------------------------------------------------------- formatting
const fmtKm = m => (m / 1000).toFixed(m < 10000 ? 1 : 0);
const fmtMin = s => {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};
const fmtKg = kg => kg < 10 ? kg.toFixed(2) : kg.toFixed(1);
const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- tabs
function show(view) {
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + view));
  if (view === 'plan') setTimeout(() => map.invalidateSize(), 0);
  if (view === 'drive') setTimeout(() => miniMap && miniMap.invalidateSize(), 0);
  if (view === 'log') renderLog();
  if (view === 'fleet') renderFleet();
}
$$('.tabs button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
$$('[data-goto]').forEach(b => b.addEventListener('click', () => show(b.dataset.goto)));

// ---------------------------------------------------------------- map
const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const map = L.map('map', { zoomControl: true }).setView([13.0, 80.22], 11);
L.tileLayer(TILE, { attribution: ATTR, maxZoom: 19 }).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const chargeLayer = L.layerGroup().addTo(map);

function status(msg) {
  const el = $('#mapStatus');
  el.hidden = !msg; el.textContent = msg || '';
}

// ---------------------------------------------------------------- geocoding + routing
const geoCache = {};
async function geocode(q) {
  q = q.trim();
  const ll = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (ll) return { lat: +ll[1], lng: +ll[2], label: q };
  if (geoCache[q]) return geoCache[q];
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  const j = await r.json();
  if (!j.length) throw new Error(`Couldn't find “${q}”`);
  return (geoCache[q] = { lat: +j[0].lat, lng: +j[0].lon, label: q });
}

async function osrm(points, alts) {
  const url = `https://router.project-osrm.org/route/v1/driving/${points.map(p => `${p.lng},${p.lat}`).join(';')}` +
    `?alternatives=${alts ? 3 : 'false'}&steps=true&overview=full&geometries=geojson`;
  const j = await (await fetch(url)).json();
  return j.code === 'Ok' ? j.routes : [];
}

async function fetchRoutes(a, b) {
  const routes = await osrm([a, b], true);
  if (!routes.length) throw new Error('No drivable route found between those places');
  // OSRM often offers a single option. Add candidates bent through a point
  // either side of the midpoint, so there is something to compare emissions on.
  if (routes.length < 3) {
    const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    const dLat = b.lat - a.lat, dLng = b.lng - a.lng;
    const span = Math.hypot(dLat, dLng);
    const s = span > 0.4 ? 0.4 : 1; // long trips: smaller sideways nudge
    const vias = [0.14, -0.14, 0.07, -0.07].map(k => ({ lat: mid.lat - dLng * k * s, lng: mid.lng + dLat * k * s }));
    const extra = await Promise.all(vias.map(v => osrm([a, v, b], false).catch(() => [])));
    const best = routes[0].duration;
    for (const [r] of extra) {
      if (!r || r.duration > best * 1.3) continue;
      if (routes.some(x => Math.abs(x.distance - r.distance) / x.distance < 0.03)) continue;
      if (hasDoubleBack(r)) continue;
      routes.push(r);
      if (routes.length >= 4) break;
    }
  }
  return routes;
}

// a via point that sits on a side street can make the route go in and straight back out
function hasDoubleBack(r) {
  if (r.legs.some(l => l.steps.some(s => s.maneuver.modifier === 'uturn'))) return true;
  // look for the path reversing on itself: thin the line to ~40 m spacing, then compare headings
  const pts = [];
  for (const [x, y] of r.geometry.coordinates) {
    const p = [y, x];
    if (!pts.length || dist2(pts.at(-1), p) > 0.04) pts.push(p);
  }
  const brg = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
  for (let i = 2; i < pts.length; i++) {
    const d = Math.abs(((brg(pts[i - 1], pts[i]) - brg(pts[i - 2], pts[i - 1])) + 540) % 360 - 180);
    if (d > 165) return true;
  }
  return false;
}

function scoreRoute(raw, veh) {
  // drop the arrive/depart pair OSRM inserts at a via point
  const n = raw.legs.length;
  const steps = raw.legs.flatMap((l, li) => l.steps.filter(s =>
    !(s.maneuver.type === 'arrive' && li < n - 1) && !(s.maneuver.type === 'depart' && li > 0))).map(s => {
    const km = s.distance / 1000;
    const freeV = s.duration ? km / (s.duration / 3600) : 50;
    const sec = s.duration * congestion(freeV, S.period);
    const co2 = stepCO2(km, sec, veh);
    return {
      km, sec, freeSec: s.duration, freeV, co2,
      coords: s.geometry.coordinates.map(([x, y]) => [y, x]),
      text: instruction(s), arrow: arrowFor(s.maneuver), name: s.name,
    };
  });
  const co2 = steps.reduce((a, s) => a + s.co2, 0);
  const fuel = co2 / veh.perUnit;
  return {
    dist: raw.distance, dur: steps.reduce((a, s) => a + s.sec, 0), co2, fuel, cost: fuel * veh.price,
    coords: raw.geometry.coordinates.map(([x, y]) => [y, x]),
    steps, via: [...new Set(raw.legs.flatMap(l => (l.summary || '').split(', ')).filter(Boolean))].slice(0, 2).join(', ') || 'local roads',
  };
}

function rankRoutes() {
  const rs = S.routes;
  rs.forEach(r => (r.tags = []));
  const eco = rs.reduce((a, r) => (r.co2 < a.co2 ? r : a), rs[0]);
  const fast = rs.reduce((a, r) => (r.dur < a.dur ? r : a), rs[0]);
  eco.tags.push('eco'); fast.tags.push('fast');
  S.eco = eco; S.fast = fast;
  rs.sort((a, b) => a.co2 - b.co2);
  S.sel = 0;
}

async function plan(fromQ, toQ) {
  const btn = $('#goBtn');
  btn.disabled = true; btn.textContent = 'Working…';
  status('Finding places…');
  try {
    const [a, b] = await Promise.all([geocode(fromQ), geocode(toQ)]);
    S.from = a; S.to = b;
    status('Asking OSRM for route options…');
    const raw = await fetchRoutes(a, b);
    const veh = VEHICLES[S.vehicle];
    S.routes = raw.map(r => scoreRoute(r, veh));
    rankRoutes();
    drawRoutes(true);
    renderRouteList();
    status('');
    if (S.vehicle === 'ev') await planCharging();
    else $('#chargePanel').hidden = true;
    return true;
  } catch (e) {
    status('');
    toast(e.message || 'Something went wrong talking to the routing service');
    $('#routeList').innerHTML = `<div class="empty-note">${e.message || 'Routing failed.'} Check the place names, or try again in a moment — the public routing server is rate-limited.</div>`;
    return false;
  } finally {
    btn.disabled = false; btn.textContent = 'Compare routes';
  }
}

function rescore() {
  // vehicle changed: re-cost existing routes without re-fetching
  if (!S.routes.length) return;
  const veh = VEHICLES[S.vehicle];
  S.routes = S.routes.map(r => {
    const steps = r.steps.map(s => {
      const sec = s.freeSec * congestion(s.freeV, S.period);
      return { ...s, sec, co2: stepCO2(s.km, sec, veh) };
    });
    const co2 = steps.reduce((a, s) => a + s.co2, 0);
    return { ...r, steps, co2, dur: steps.reduce((a, s) => a + s.sec, 0), fuel: co2 / veh.perUnit, cost: (co2 / veh.perUnit) * veh.price };
  });
  rankRoutes(); drawRoutes(false); renderRouteList();
  if (S.vehicle === 'ev') planCharging(); else { $('#chargePanel').hidden = true; chargeLayer.clearLayers(); }
}

// ---------------------------------------------------------------- route drawing
const colorOf = r => r.tags.includes('eco') ? 'var(--eco)' : r.tags.includes('fast') ? 'var(--fast)' : 'var(--other)';
const hexOf = r => r.tags.includes('eco') ? '#1e6a48' : r.tags.includes('fast') ? '#c76a1c' : '#8c8778';

function drawRoutes(fit) {
  routeLayer.clearLayers();
  S.routes.forEach((r, i) => {
    if (i === S.sel) return;
    L.polyline(r.coords, { color: hexOf(r), weight: 4, opacity: .75, dashArray: '6 6' })
      .on('click', () => select(i)).addTo(routeLayer);
  });
  const r = S.routes[S.sel];
  L.polyline(r.coords, { color: '#1b1b18', weight: 9, opacity: 1 }).addTo(routeLayer);
  L.polyline(r.coords, { color: hexOf(r), weight: 5, opacity: 1 }).addTo(routeLayer);
  const pin = cls => L.divIcon({ className: '', html: `<div class="end-pin ${cls}"></div>`, iconSize: [14, 14] });
  L.marker([S.from.lat, S.from.lng], { icon: pin('a') }).bindTooltip(S.from.label).addTo(routeLayer);
  L.marker([S.to.lat, S.to.lng], { icon: pin('b') }).bindTooltip(S.to.label).addTo(routeLayer);
  if (fit) map.fitBounds(L.latLngBounds(S.routes.flatMap(x => [x.coords[0], x.coords.at(-1), ...x.coords.filter((_, k) => k % 40 === 0)])), { padding: [60, 60] });
}

function select(i) {
  S.sel = i;
  drawRoutes(false);
  renderRouteList();
  if (S.vehicle === 'ev') planCharging();
}

function renderRouteList() {
  const veh = VEHICLES[S.vehicle];
  const fast = S.fast;
  const maxCo2 = Math.max(...S.routes.map(r => r.co2));
  const html = S.routes.map((r, i) => {
    const tags = r.tags.map(t => `<span class="tag ${t}">${t === 'eco' ? 'Lowest CO₂' : 'Fastest'}</span>`).join('') || '<span class="tag other">Option</span>';
    let delta = '';
    if (r !== fast) {
      const dMin = Math.round((r.dur - fast.dur) / 60);
      const dKg = r.co2 - fast.co2;
      const pct = Math.round((dKg / fast.co2) * 100);
      delta = `<div class="r-delta">vs fastest: <span class="${dMin > 0 ? 'plus' : 'minus'}">${dMin >= 0 ? '+' : '−'}${Math.abs(dMin)} min</span> · ` +
        `<span class="${dKg < 0 ? 'minus' : 'plus'}">${dKg < 0 ? '−' : '+'}${fmtKg(Math.abs(dKg))} kg CO₂ (${pct > 0 ? '+' : ''}${pct}%)</span> · ${dKg < 0 ? 'saves' : 'costs'} ${inr(Math.abs(dKg / veh.perUnit * veh.price))}</div>`;
    } else if (S.routes.length === 1) {
      delta = `<div class="r-delta">OSRM returned one sensible route for this trip, so it is both fastest and greenest.</div>`;
    } else {
      delta = `<div class="r-delta">Quickest option. Always available — the eco suggestion never overrides your choice.</div>`;
    }
    return `<div class="r ${i === S.sel ? 'sel' : ''}" data-i="${i}">
      <div class="r-head">${tags}<span class="r-name" title="${r.via}">via ${r.via}</span></div>
      <div class="r-nums">
        <div><b>${fmtMin(r.dur)}</b><span>time</span></div>
        <div><b>${fmtKm(r.dist)}</b><span>km</span></div>
        <div><b>${fmtKg(r.co2)}</b><span>kg CO₂ est.</span></div>
        <div><b>${r.fuel.toFixed(2)}</b><span>${veh.unit} · ${inr(r.cost)}</span></div>
      </div>
      <div class="r-bar"><i style="width:${(r.co2 / maxCo2) * 100}%;background:${colorOf(r)}"></i></div>
      ${delta}
      ${i === S.sel ? `<div class="r-actions"><button class="primary" data-act="drive">Drive this route</button><button class="ghost" data-act="read">Read aloud</button></div>` : ''}
    </div>`;
  }).join('');
  $('#routeList').innerHTML = html;
  $$('#routeList .r').forEach(el => el.addEventListener('click', e => {
    const act = e.target.dataset.act;
    if (act === 'drive') return startDrive();
    if (act === 'read') return speak(describeComparison());
    select(+el.dataset.i);
  }));
}

function describeComparison() {
  const e = S.eco, f = S.fast;
  if (!e) return 'Plan a route first.';
  if (e === f) return `The fastest route is also the greenest: ${fmtMin(f.dur)}, about ${fmtKg(f.co2)} kilograms of CO2.`;
  const dMin = Math.round((e.dur - f.dur) / 60);
  const pct = Math.round(((f.co2 - e.co2) / f.co2) * 100);
  return `The eco route via ${e.via} takes ${dMin > 0 ? dMin + ' minutes longer' : 'about the same time'} and cuts emissions by about ${pct} percent, ` +
    `${fmtKg(e.co2)} kilograms versus ${fmtKg(f.co2)}. The fastest route goes via ${f.via}.`;
}

// ---------------------------------------------------------------- EV charging
async function planCharging() {
  const panel = $('#chargePanel');
  chargeLayer.clearLayers();
  const r = S.routes[S.sel];
  const cap = +$('#capacity').value || 30;
  const startPct = Math.min(100, +$('#battery').value || 50);
  const veh = VEHICLES.ev;
  let pct = startPct, kmDone = 0;
  const stops = [];
  // walk the route; when we'd drop below 20%, mark a stop and assume a top-up to 80%
  for (const s of r.steps) {
    const kwh = s.co2 / veh.perUnit;
    const after = pct - (kwh / cap) * 100;
    if (after < 20 && stops.length < 4) {
      const frac = Math.max(0, (pct - 20) / (pct - after));
      const at = pointAlong(s.coords, frac);
      stops.push({ at, km: kmDone + s.km * frac, arrive: 20 });
      pct = 80 - (kwh * (1 - frac) / cap) * 100;
    } else pct = after;
    kmDone += s.km;
  }
  const arrival = Math.max(0, pct);
  const energy = r.co2 / veh.perUnit;

  panel.hidden = false;
  if (!stops.length) {
    panel.innerHTML = `<h4>Charge check <span class="meta">${energy.toFixed(1)} kWh needed</span></h4>
      <div class="batt"><i style="width:${arrival}%"></i><em style="left:15%"></em></div>
      <div class="meta">Leave at ${startPct}% → arrive around ${Math.round(arrival)}%. No stop needed${arrival < 25 ? ', but it will be tight — top up if you can' : ''}.</div>`;
    return;
  }
  panel.innerHTML = `<h4>Charging stops <span class="meta">${energy.toFixed(1)} kWh · ${stops.length} stop${stops.length > 1 ? 's' : ''}</span></h4>
    <div class="meta">${stops[0].km < 2 ? `${startPct}% is too low to set off — top up near the start.` : `Leaving at ${startPct}% you'd reach 20% around km ${Math.round(stops[0].km)}.`} Chargers near each low point, from OpenStreetMap:</div><ol id="chgList"></ol>`;
  const list = $('#chgList');
  for (const [k, st] of stops.entries()) {
    const li = document.createElement('li');
    li.innerHTML = `<b>Around km ${Math.round(st.km)}</b> <span class="meta">— searching…</span>`;
    list.appendChild(li);
    try {
      const found = await findChargers(st.at);
      if (found) {
        const where = st.km < 2 ? 'before you leave' : `km ${Math.round(st.km)}`;
        li.innerHTML = `<b>${found.name}</b><br><span class="meta">${where} · ${found.off.toFixed(1)} km off route · arrive ~20%, charge to 80%${found.socket ? ' · ' + found.socket : ''}</span>`;
        L.marker([found.lat, found.lng], { icon: L.divIcon({ className: '', html: '<div class="chg-pin"></div>', iconSize: [14, 14] }) })
          .bindPopup(`<b>${found.name}</b><br>Stop ${k + 1} · km ${Math.round(st.km)}${found.op ? '<br>' + found.op : ''}`).addTo(chargeLayer);
      } else {
        li.innerHTML = `<b>Around km ${Math.round(st.km)}</b><br><span class="meta">No mapped charger within 6 km. Charge before leaving or plan a detour.</span>`;
      }
    } catch {
      li.innerHTML = `<b>Around km ${Math.round(st.km)}</b><br><span class="meta">Charger lookup unavailable right now (Overpass busy). Plan a stop near here.</span>`;
    }
  }
}

function pointAlong(coords, frac) {
  if (coords.length < 2) return coords[0];
  const i = Math.min(coords.length - 2, Math.floor(frac * (coords.length - 1)));
  return coords[i];
}

const dist2 = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

async function findChargers([lat, lng]) {
  const q = `[out:json][timeout:15];node(around:6000,${lat},${lng})[amenity=charging_station];out 15;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
  if (!r.ok) throw new Error('overpass');
  const j = await r.json();
  if (!j.elements.length) return null;
  const best = j.elements.map(e => ({ e, d: dist2([lat, lng], [e.lat, e.lon]) })).sort((a, b) => a.d - b.d)[0];
  const t = best.e.tags || {};
  const sockets = Object.keys(t).filter(k => k.startsWith('socket:') && !k.includes(':output')).map(k => k.split(':')[1].replace(/_/g, ' '));
  return {
    lat: best.e.lat, lng: best.e.lon, off: best.d,
    name: (n => n[0].toUpperCase() + n.slice(1))(t.name || t.operator || t.brand || 'Charging station'),
    op: t.operator, socket: sockets.slice(0, 2).join(', '),
  };
}

// ---------------------------------------------------------------- form
$('#routeForm').addEventListener('submit', e => { e.preventDefault(); plan($('#from').value, $('#to').value); });
$('#swap').addEventListener('click', () => { const f = $('#from').value; $('#from').value = $('#to').value; $('#to').value = f; });
$('#period').value = S.period;
$('#period').addEventListener('change', e => { S.period = e.target.value; rescore(); });
$('#vehicle').addEventListener('change', e => {
  S.vehicle = e.target.value;
  $('#evFields').hidden = S.vehicle !== 'ev';
  rescore();
});
['#battery', '#capacity'].forEach(id => $(id).addEventListener('change', () => S.routes.length && planCharging()));
$('#useLoc').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('This browser has no location access');
  toast('Your browser will ask first. Location is used once for this route and not stored.');
  navigator.geolocation.getCurrentPosition(
    p => { $('#from').value = `${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`; toast('Start set to your current position'); },
    () => toast('Location not shared — type a start point instead'),
    { enableHighAccuracy: false, timeout: 8000 }
  );
});

// ---------------------------------------------------------------- drive (simulated)
let miniMap = null, carMarker = null;

function arrowFor(m) {
  const mod = m.modifier || '', t = m.type;
  if (t === 'arrive') return '■';
  if (t === 'roundabout' || t === 'rotary') return '⟳';
  return { left: '←', right: '→', 'slight left': '↖', 'slight right': '↗', 'sharp left': '↙', 'sharp right': '↘', uturn: '↶' }[mod] || '↑';
}
function instruction(s) {
  const m = s.maneuver, road = s.name ? ` onto ${s.name}` : '';
  const mod = m.modifier ? m.modifier : '';
  switch (m.type) {
    case 'depart': return `Head ${dirWord(m.bearing_after)}${s.name ? ' on ' + s.name : ''}`;
    case 'arrive': return 'Arrive at destination';
    case 'turn': case 'end of road': return `Turn ${mod}${road}`;
    case 'new name': return `Continue${road}`;
    case 'merge': return `Merge ${mod}${road}`;
    case 'on ramp': return `Take the ramp ${mod}${road}`;
    case 'off ramp': return `Take the exit ${mod}${road}`;
    case 'fork': return `Keep ${mod}${road}`;
    case 'roundabout': case 'rotary': return `At the roundabout, take exit ${m.exit || 1}${road}`;
    default: return mod && mod !== 'straight' ? `Bear ${mod}${road}` : `Continue${road}`;
  }
}
const dirWord = b => ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round((b || 0) / 45) % 8];

function startDrive() {
  const r = S.routes[S.sel];
  if (!r) return show('plan');
  const veh = VEHICLES[S.vehicle];
  let t = 0;
  const steps = r.steps.map(s => { const o = { ...s, t0: t }; t += s.sec; return o; });
  S.drive = { r, veh, steps, total: t, elapsed: 0, idx: -1, co2: 0, km: 0, paused: false, last: performance.now(),
    batt: +$('#battery').value, cap: +$('#capacity').value };
  $('#driveEmpty').hidden = true; $('#driveUI').hidden = false;
  $('#gFuelLbl').textContent = S.vehicle === 'ev' ? 'Energy used' : 'Fuel used';
  $('#gFuelUnit').textContent = veh.unit;
  $('#gBattWrap').hidden = S.vehicle !== 'ev';
  $('#dPause').textContent = 'Pause';
  show('drive');
  if (!miniMap) {
    miniMap = L.map('miniMap', { zoomControl: false, attributionControl: true });
    L.tileLayer(TILE, { attribution: ATTR, maxZoom: 19 }).addTo(miniMap);
  }
  miniMap.eachLayer(l => { if (!(l instanceof L.TileLayer)) miniMap.removeLayer(l); });
  setTimeout(() => {
    miniMap.invalidateSize();
    L.polyline(r.coords, { color: '#f0a443', weight: 5 }).addTo(miniMap);
    carMarker = L.marker(r.coords[0], { icon: L.divIcon({ className: '', html: '<div class="car-pin"></div>', iconSize: [16, 16] }) }).addTo(miniMap);
    miniMap.setView(r.coords[0], 15);
  }, 30);
  speak(`Starting. ${r.tags.includes('eco') ? 'You are on the lower-emission route.' : ''} ${fmtMin(r.dur)} to ${S.to.label}.`);
  cancelAnimationFrame(S.raf);
  S.raf = requestAnimationFrame(tick);
}

function tick(now) {
  const d = S.drive;
  if (!d) return;
  const dt = (now - d.last) / 1000; d.last = now;
  if (!d.paused) d.elapsed = Math.min(d.total, d.elapsed + dt * +$('#dSim').value);
  // which step are we in
  let i = d.steps.findIndex(s => d.elapsed < s.t0 + s.sec);
  if (i < 0) i = d.steps.length - 1;
  const s = d.steps[i];
  const f = s.sec ? Math.min(1, (d.elapsed - s.t0) / s.sec) : 1;
  // totals so far
  let co2 = 0, km = 0;
  for (let k = 0; k < i; k++) { co2 += d.steps[k].co2; km += d.steps[k].km; }
  co2 += s.co2 * f; km += s.km * f;
  d.co2 = co2; d.km = km;

  if (i !== d.idx) { d.idx = i; onStep(i); }
  const next = d.steps[Math.min(i + 1, d.steps.length - 1)];
  const left = s.km * (1 - f);
  $('#dArrow').textContent = next.arrow;
  $('#dIn').textContent = i === d.steps.length - 1 ? 'Arriving' : left < 1 ? `${Math.round(left * 1000 / 10) * 10} m` : `${left.toFixed(1)} km`;
  $('#dInstr').textContent = next.text;
  const v = s.sec ? s.km / (s.sec / 3600) : 0;
  $('#gSpeed').textContent = d.paused ? 0 : Math.round(v + Math.sin(now / 700) * Math.min(4, v * .08));
  $('#gCO2').textContent = co2.toFixed(2);
  $('#gFuel').textContent = (co2 / d.veh.perUnit).toFixed(2);
  $('#gRem').textContent = Math.max(0, d.r.dist / 1000 - km).toFixed(1);
  if (S.vehicle === 'ev') $('#gBatt').textContent = Math.max(0, Math.round(d.batt - (co2 / d.veh.perUnit) / d.cap * 100));
  $('#dProg').style.width = (d.elapsed / d.total) * 100 + '%';
  if (carMarker && s.coords.length) {
    const pos = interp(s.coords, f);
    carMarker.setLatLng(pos);
    if (!miniMap.getBounds().pad(-0.25).contains(pos)) miniMap.panTo(pos, { animate: true });
  }
  if (d.elapsed >= d.total) { endDrive(true); return; }
  S.raf = requestAnimationFrame(tick);
}

function interp(coords, f) {
  if (coords.length === 1) return coords[0];
  const segs = []; let tot = 0;
  for (let k = 1; k < coords.length; k++) { const l = dist2(coords[k - 1], coords[k]); segs.push(l); tot += l; }
  let target = tot * f;
  for (let k = 0; k < segs.length; k++) {
    if (target <= segs[k] || k === segs.length - 1) {
      const u = segs[k] ? Math.min(1, target / segs[k]) : 0;
      return [coords[k][0] + (coords[k + 1][0] - coords[k][0]) * u, coords[k][1] + (coords[k + 1][1] - coords[k][1]) * u];
    }
    target -= segs[k];
  }
  return coords.at(-1);
}

function onStep(i) {
  const d = S.drive, s = d.steps[i], next = d.steps[i + 1];
  const v = s.sec ? s.km / (s.sec / 3600) : 0;
  let tip;
  if (S.vehicle === 'ev' && v < 30) tip = 'Slow stretch: ease off early and let regenerative braking do the work.';
  else if (v < 20) tip = 'Stop-start stretch ahead. Gentle pull-aways and no idling at long signals save the most here.';
  else if (v > 85) tip = `Fast road. Holding 80 instead of ${Math.round(v)} km/h cuts fuel on this stretch by roughly ${Math.round((1 - speedCurve(80, d.veh) / speedCurve(v, d.veh)) * 100)}%.`;
  else if (v > 45) tip = 'Good cruising speed. Keep it steady — this is where the engine is most efficient.';
  else tip = 'Moderate traffic. Leave space ahead so you can coast instead of braking.';
  $('#coach').textContent = tip;
  if (next && $('#dSpeak').checked) {
    const dist = s.km < 1 ? `${Math.round(s.km * 10) * 100} metres` : `${s.km.toFixed(1)} kilometres`;
    speak(next.text === 'Arrive at destination' ? `In ${dist}, you will arrive.` : `In ${dist}, ${next.text}.`);
  }
}

function endDrive(arrived) {
  const d = S.drive;
  if (!d) return;
  cancelAnimationFrame(S.raf);
  const frac = d.elapsed / d.total;
  if (frac > 0.02) {
    const fast = S.fast;
    S.trips.unshift({
      date: new Date().toISOString(), from: S.from.label, to: S.to.label, vehicle: S.vehicle,
      km: d.km, min: d.elapsed / 60, co2: d.co2, fuel: d.co2 / d.veh.perUnit, unit: d.veh.unit,
      choice: d.r.tags.includes('eco') ? 'eco' : d.r.tags.includes('fast') ? 'fast' : 'other',
      fastCo2: fast.co2 * frac, fastMin: (fast.dur / 60) * frac, price: d.veh.price,
    });
    saveTrips();
  }
  speak(arrived ? `You have arrived. This trip produced about ${fmtKg(d.co2)} kilograms of CO2.` : 'Trip ended and saved to your log.');
  S.drive = null;
  $('#driveUI').hidden = true; $('#driveEmpty').hidden = false;
  show('log');
  toast(frac > 0.02 ? 'Trip saved to your log' : 'Trip too short to log');
}

$('#dPause').addEventListener('click', () => {
  if (!S.drive) return;
  S.drive.paused = !S.drive.paused;
  $('#dPause').textContent = S.drive.paused ? 'Resume' : 'Pause';
});
$('#dEnd').addEventListener('click', () => endDrive(false));

// ---------------------------------------------------------------- log
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }

function renderLog() {
  const T = S.trips;
  const sum = k => T.reduce((a, t) => a + t[k], 0);
  const co2 = sum('co2'), km = sum('km'), fastCo2 = sum('fastCo2');
  const saved = fastCo2 - co2;
  const ecoShare = T.length ? T.filter(t => t.choice === 'eco').length / T.length : 0;
  $('#logStats').innerHTML = `
    <div class="stat"><span>Trips</span><b>${T.length}</b></div>
    <div class="stat"><span>Distance</span><b>${km.toFixed(0)}</b><em>km</em></div>
    <div class="stat"><span>CO₂ emitted</span><b>${fmtKg(co2)}</b><em>kg</em><small>${km ? Math.round(co2 / km * 1000) : 0} g/km average</small></div>
    <div class="stat good"><span>Avoided vs fastest</span><b>${fmtKg(Math.max(0, saved))}</b><em>kg</em><small>${fastCo2 ? Math.round(saved / fastCo2 * 100) : 0}% lower</small></div>
    <div class="stat"><span>Eco route taken</span><b>${Math.round(ecoShare * 100)}</b><em>%</em><small>of trips</small></div>`;

  // weekly chart: solid = actual, outline = what the fastest routes would have emitted
  const now = weekStart(new Date());
  const weeks = [...Array(8)].map((_, k) => { const w = new Date(now); w.setDate(w.getDate() - 7 * (7 - k)); return { w, co2: 0, fast: 0 }; });
  T.forEach(t => {
    const ws = weekStart(t.date).getTime();
    const b = weeks.find(x => x.w.getTime() === ws);
    if (b) { b.co2 += t.co2; b.fast += t.fastCo2; }
  });
  const W = 600, H = 210, P = 30, max = Math.max(1, ...weeks.map(w => Math.max(w.co2, w.fast)));
  const bw = (W - P - 10) / 8;
  let svg = `<svg viewBox="0 0 ${W} ${H}">`;
  [0, .5, 1].forEach(g => {
    const y = H - 24 - (H - 40) * g;
    svg += `<line x1="${P}" x2="${W}" y1="${y}" y2="${y}" stroke="#ddd8ca"/><text x="${P - 6}" y="${y + 3}" text-anchor="end">${(max * g).toFixed(0)}</text>`;
  });
  weeks.forEach((w, k) => {
    const x = P + 6 + k * bw, h = (H - 40) * (w.co2 / max), hf = (H - 40) * (w.fast / max);
    svg += `<rect x="${x}" y="${H - 24 - hf}" width="${bw - 14}" height="${hf}" fill="none" stroke="#c76a1c" stroke-dasharray="3 3"/>`;
    svg += `<rect x="${x}" y="${H - 24 - h}" width="${bw - 14}" height="${h}" fill="#1b1b18"/>`;
    svg += `<text x="${x + (bw - 14) / 2}" y="${H - 8}" text-anchor="middle">${w.w.getDate()}/${w.w.getMonth() + 1}</text>`;
  });
  svg += `<rect x="${W - 210}" y="4" width="10" height="10" fill="#1b1b18"/><text x="${W - 196}" y="13">actual</text>`;
  svg += `<rect x="${W - 140}" y="4" width="10" height="10" fill="none" stroke="#c76a1c" stroke-dasharray="3 3"/><text x="${W - 126}" y="13">if always fastest</text></svg>`;
  $('#weekChart').innerHTML = T.length ? svg : '<p class="muted">No trips yet. Drive a route, or load the sample month.</p>';

  const fuelSaved = T.reduce((a, t) => a + (t.fastCo2 - t.co2) / VEHICLES[t.vehicle].perUnit * t.price, 0);
  const extraMin = T.reduce((a, t) => a + (t.min - t.fastMin), 0);
  $('#savedBox').innerHTML = `
    <div class="saved-row"><span>CO₂ avoided</span><b>${fmtKg(Math.max(0, saved))} kg</b></div>
    <div class="saved-row"><span>Fuel / energy money kept</span><b>${inr(Math.max(0, fuelSaved))}</b></div>
    <div class="saved-row"><span>Extra time on the road</span><b>${Math.round(extraMin)} min</b></div>
    <div class="saved-row"><span>CO₂ saved per extra minute</span><b>${extraMin > 0 ? fmtKg(saved / extraMin) + ' kg/min' : '—'}</b></div>
    <p class="equiv">${saved > 1 ? `Roughly what ${Math.max(1, Math.round(saved / 21 * 12))} month${Math.round(saved / 21 * 12) === 1 ? '' : 's'} of growth absorbs for one mature tree (≈21 kg CO₂ a year).` : 'Savings show up here once you have a few trips.'}</p>`;

  $('#tripTable').innerHTML = `<tr><th>Date</th><th>Trip</th><th>Vehicle</th><th class="n">km</th><th class="n">min</th><th class="n">kg CO₂</th><th class="n">vs fastest</th><th>Route</th></tr>` +
    T.slice(0, 60).map(t => `<tr>
      <td>${new Date(t.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</td>
      <td>${t.from} → ${t.to}</td><td>${VEHICLES[t.vehicle].name}</td>
      <td class="n">${t.km.toFixed(1)}</td><td class="n">${Math.round(t.min)}</td><td class="n">${t.co2.toFixed(2)}</td>
      <td class="n">${t.fastCo2 - t.co2 > 0.005 ? '−' + (t.fastCo2 - t.co2).toFixed(2) : '0.00'}</td>
      <td><span class="chip ${t.choice}">${t.choice === 'eco' ? 'eco' : t.choice === 'fast' ? 'fastest' : 'other'}</span></td></tr>`).join('') +
    (T.length ? '' : '<tr><td colspan="8" class="muted">Nothing logged.</td></tr>');
}

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

$('#seedTrips').addEventListener('click', () => {
  const R = rng(7);
  const places = [['T. Nagar', 'Guindy'], ['Velachery', 'OMR Sholinganallur'], ['Anna Nagar', 'Chennai Central'], ['Adyar', 'Tambaram'], ['Porur', 'T. Nagar'], ['Chennai Central', 'Mahabalipuram']];
  const out = [];
  for (let k = 0; k < 26; k++) {
    const [a, b] = places[Math.floor(R() * places.length)];
    const km = 6 + R() * (b === 'Mahabalipuram' ? 50 : 18);
    const veh = R() < .75 ? 'petrol' : 'ev';
    const v = VEHICLES[veh];
    const fastCo2 = km * v.base * (1.25 + R() * .3);
    const choice = R() < .62 ? 'eco' : 'fast';
    const co2 = choice === 'eco' ? fastCo2 * (0.8 + R() * 0.12) : fastCo2;
    const fastMin = km / (24 + R() * 14) * 60;
    const d = new Date(); d.setDate(d.getDate() - Math.floor(R() * 52)); d.setHours(8 + Math.floor(R() * 11));
    out.push({ date: d.toISOString(), from: a, to: b, vehicle: veh, km, co2, fuel: co2 / v.perUnit, unit: v.unit, choice,
      fastCo2, fastMin, min: choice === 'eco' ? fastMin + 2 + R() * 6 : fastMin, price: v.price, sample: true });
  }
  S.trips = [...S.trips.filter(t => !t.sample), ...out].sort((a, b) => b.date.localeCompare(a.date));
  saveTrips(); renderLog(); toast('Loaded 26 sample trips (marked as samples)');
});
$('#clearTrips').addEventListener('click', () => {
  if (!confirm('Delete every trip stored in this browser?')) return;
  S.trips = []; saveTrips(); renderLog(); toast('Your trip data was deleted');
});
$('#exportTrips').addEventListener('click', () => {
  const rows = [['date', 'from', 'to', 'vehicle', 'km', 'minutes', 'kg_co2_est', 'kg_co2_if_fastest', 'route']]
    .concat(S.trips.map(t => [t.date, t.from, t.to, t.vehicle, t.km.toFixed(2), t.min.toFixed(1), t.co2.toFixed(3), t.fastCo2.toFixed(3), t.choice]));
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'aetherx-trips.csv'; a.click();
});

// ---------------------------------------------------------------- fleet (demo data)
const FLEET = (() => {
  const R = rng(42);
  const drivers = ['R. Kumar', 'S. Priya', 'M. Arjun', 'K. Lakshmi', 'P. Vignesh', 'A. Fathima', 'J. Daniel', 'N. Meena', 'V. Karthik', 'B. Suresh', 'D. Anitha', 'T. Rahul'];
  const types = ['lcv', 'lcv', 'lcv', 'diesel', 'lcv', 'ev', 'lcv', 'diesel', 'ev', 'lcv', 'petrol', 'lcv'];
  return drivers.map((dr, k) => {
    const type = types[k];
    const reg = `TN ${String(9 + Math.floor(R() * 14)).padStart(2, '0')} ${'ABCDEFGHJK'[Math.floor(R() * 10)]}${'LMNPRSTUVX'[Math.floor(R() * 10)]} ${1000 + Math.floor(R() * 8999)}`;
    const eff = 0.85 + R() * 0.55;            // multiplier on the model's base factor
    const kmDay = 60 + R() * 110;
    const idle = 4 + R() * 18;                 // % of engine time idling
    const adopt = type === 'ev' ? 40 + R() * 55 : 15 + R() * 75; // % trips on eco route
    return { reg, dr, type, eff, kmDay, idle, adopt };
  });
})();
let fleetSort = { key: 'score', asc: false };

function fleetRows(days) {
  return FLEET.map(f => {
    const v = VEHICLES[f.type];
    const km = f.kmDay * days;
    const gkm = v.base * 1.2 * f.eff * 1000 * (1 + f.idle / 200);
    const co2 = gkm * km / 1000; // kg
    const bench = v.base * 1.2 * 1000;
    const score = Math.round(Math.max(5, Math.min(99, 100 - (gkm / bench - 0.85) * 120 - f.idle * 1.2 + f.adopt * .25)));
    return { ...f, km, gkm, co2, fuel: co2 / v.perUnit, unit: v.unit, score };
  });
}

function renderFleet() {
  const days = +$('#fleetRange').value;
  let rows = fleetRows(days);
  const tot = k => rows.reduce((a, r) => a + r[k], 0);
  const co2 = tot('co2'), km = tot('km');
  const avgScore = Math.round(tot('score') / rows.length);
  const adopt = Math.round(tot('adopt') / rows.length);
  // if every vehicle took the eco route 90% of the time (eco ≈ 12% lower)
  const potential = rows.reduce((a, r) => a + r.co2 * Math.max(0, 0.9 - r.adopt / 100) * 0.12, 0);
  $('#fleetStats').innerHTML = `
    <div class="stat"><span>Vehicles</span><b>${rows.length}</b><small>${rows.filter(r => r.type === 'ev').length} electric</small></div>
    <div class="stat"><span>Distance</span><b>${Math.round(km).toLocaleString('en-IN')}</b><em>km</em></div>
    <div class="stat"><span>CO₂ (est.)</span><b>${(co2 / 1000).toFixed(2)}</b><em>t</em><small>${Math.round(co2 / km * 1000)} g/km fleet average</small></div>
    <div class="stat"><span>Eco-route adoption</span><b>${adopt}</b><em>%</em></div>
    <div class="stat good"><span>Still on the table</span><b>${Math.round(potential)}</b><em>kg</em><small>at 90% eco-route use</small></div>`;

  const k = fleetSort.key;
  rows.sort((a, b) => (typeof a[k] === 'string' ? a[k].localeCompare(b[k]) : a[k] - b[k]) * (fleetSort.asc ? 1 : -1));
  const cols = [['reg', 'Vehicle'], ['dr', 'Driver'], ['type', 'Type'], ['km', 'km', 1], ['gkm', 'g CO₂/km', 1], ['co2', 'kg CO₂', 1], ['idle', 'Idle %', 1], ['adopt', 'Eco route %', 1], ['score', 'Score']];
  $('#fleetTable').innerHTML = `<tr>${cols.map(([key, l, n]) => `<th data-k="${key}" class="${n ? 'n' : ''} ${k === key ? 's' + (fleetSort.asc ? ' asc' : '') : ''}">${l}</th>`).join('')}</tr>` +
    rows.map(r => `<tr><td style="font-family:var(--mono)">${r.reg}</td><td>${r.dr}</td><td>${VEHICLES[r.type].name.replace(' (diesel)', '')}</td>
      <td class="n">${Math.round(r.km).toLocaleString('en-IN')}</td><td class="n">${Math.round(r.gkm)}</td><td class="n">${Math.round(r.co2)}</td>
      <td class="n" style="color:${r.idle > 15 ? 'var(--fast)' : ''}">${r.idle.toFixed(1)}</td><td class="n">${Math.round(r.adopt)}</td>
      <td><span class="score"><i><b style="width:${r.score}%;background:${r.score < 50 ? 'var(--fast)' : 'var(--eco)'}"></b></i><span style="font-family:var(--mono)">${r.score}</span></span></td></tr>`).join('');
  $$('#fleetTable th').forEach(th => th.addEventListener('click', () => {
    fleetSort = { key: th.dataset.k, asc: fleetSort.key === th.dataset.k ? !fleetSort.asc : false };
    renderFleet();
  }));

  // scatter
  const W = 600, H = 260, P = 40;
  const xs = rows.map(r => r.km), ys = rows.map(r => r.gkm);
  const x0 = 0, x1 = Math.max(...xs) * 1.1, y0 = 0, y1 = Math.max(...ys) * 1.15;
  const X = v => P + (W - P - 10) * (v - x0) / (x1 - x0), Y = v => H - 26 - (H - 40) * (v - y0) / (y1 - y0);
  const typeColor = { lcv: '#1b1b18', diesel: '#c76a1c', ev: '#2a5a86', petrol: '#8c8778' };
  let svg = `<svg viewBox="0 0 ${W} ${H}">`;
  for (let g = 0; g <= 4; g++) { const y = Y(y1 * g / 4); svg += `<line x1="${P}" x2="${W}" y1="${y}" y2="${y}" stroke="#ddd8ca"/><text x="${P - 6}" y="${y + 3}" text-anchor="end">${Math.round(y1 * g / 4)}</text>`; }
  svg += `<text x="${W - 4}" y="${H - 6}" text-anchor="end">km driven →</text><text x="${P}" y="10">g CO₂/km ↑</text>`;
  rows.forEach(r => { svg += `<circle cx="${X(r.km)}" cy="${Y(r.gkm)}" r="6" fill="${typeColor[r.type]}" fill-opacity=".85"><title>${r.reg} · ${r.dr}\n${Math.round(r.gkm)} g/km · ${Math.round(r.km)} km</title></circle>`; });
  Object.entries({ lcv: 'Van', diesel: 'Diesel SUV', ev: 'EV', petrol: 'Petrol' }).forEach(([t, l], i) => {
    svg += `<circle cx="${W - 340 + i * 82}" cy="24" r="5" fill="${typeColor[t]}"/><text x="${W - 332 + i * 82}" y="27">${l}</text>`;
  });
  $('#fleetScatter').innerHTML = svg + '</svg>';

  const flags = [];
  rows.filter(r => r.idle > 15).forEach(r => flags.push(['w', 'IDLE', `${r.reg} (${r.dr}) idles ${r.idle.toFixed(0)}% of engine time. Switching off at stops > 1 min would help.`]));
  rows.filter(r => r.adopt < 30 && r.type !== 'ev').forEach(r => flags.push(['w', 'ROUTE', `${r.dr} took the eco route on only ${Math.round(r.adopt)}% of trips.`]));
  const best = [...rows].sort((a, b) => b.score - a.score)[0];
  flags.push(['ok', 'BEST', `${best.dr} (${best.reg}) leads with a score of ${best.score}.`]);
  const ev = rows.filter(r => r.type === 'ev');
  if (ev.length) flags.push(['ok', 'EV', `EVs average ${Math.round(ev.reduce((a, r) => a + r.gkm, 0) / ev.length)} g/km against ${Math.round(rows.filter(r => r.type === 'lcv').reduce((a, r, _, A) => a + r.gkm / A.length, 0))} g/km for diesel vans.`]);
  $('#fleetFlags').innerHTML = flags.map(([c, t, m]) => `<li><b class="${c}">${t}</b><span>${m}</span></li>`).join('');
}
$('#fleetRange').addEventListener('change', renderFleet);

// ---------------------------------------------------------------- method page
(function renderMethod() {
  $('#factorTable').innerHTML = `<tr><th>Vehicle</th><th class="n">base kg CO₂/km</th><th>burns</th><th class="n">kg CO₂ per unit</th><th class="n">price used</th></tr>` +
    Object.values(VEHICLES).map(v => `<tr><td>${v.name}</td><td class="n">${v.base.toFixed(3)}</td><td>${v.unit === 'kWh' ? 'grid electricity' : v.unit === 'kg' ? 'CNG' : v.perUnit > 2.5 ? 'diesel' : 'petrol'}</td><td class="n">${v.perUnit}</td><td class="n">₹${v.price}/${v.unit}</td></tr>`).join('');
  const W = 600, H = 200, P = 34;
  const X = v => P + (W - P - 10) * (v - 5) / 125, Y = f => H - 24 - (H - 40) * (f - 1) / 1.2;
  let svg = `<svg viewBox="0 0 ${W} ${H}">`;
  [1, 1.4, 1.8, 2.2].forEach(f => { svg += `<line x1="${P}" x2="${W}" y1="${Y(f)}" y2="${Y(f)}" stroke="#ddd8ca"/><text x="${P - 6}" y="${Y(f) + 3}" text-anchor="end">${f.toFixed(1)}×</text>`; });
  [20, 40, 60, 80, 100, 120].forEach(v => { svg += `<text x="${X(v)}" y="${H - 6}" text-anchor="middle">${v}</text>`; });
  const line = (veh, col) => { let d = ''; for (let v = 5; v <= 130; v += 2.5) d += (d ? 'L' : 'M') + X(v).toFixed(1) + ' ' + Y(Math.min(2.2, speedCurve(v, veh))).toFixed(1); return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2"/>`; };
  svg += line(VEHICLES.petrol, '#1b1b18') + line(VEHICLES.ev, '#2a5a86');
  svg += `<line x1="${X(60)}" x2="${X(60)}" y1="${Y(1)}" y2="${Y(2.2)}" stroke="#1e6a48" stroke-dasharray="3 3"/><text x="${X(60) + 4}" y="${Y(2.1)}">best ≈ 60 km/h</text>`;
  svg += `<text x="${W - 120}" y="14" style="fill:#1b1b18">— petrol</text><text x="${W - 60}" y="14" style="fill:#2a5a86">— EV</text><text x="${W - 4}" y="${H - 18}" text-anchor="end">km/h</text></svg>`;
  $('#curveChart').innerHTML = svg;
})();

// ---------------------------------------------------------------- voice
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, voice = null;

function pickVoice() {
  const vs = speechSynthesis.getVoices();
  voice = vs.find(v => v.lang === 'en-IN') || vs.find(v => v.lang.startsWith('en-GB')) || vs.find(v => v.lang.startsWith('en')) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 1.02;
  speechSynthesis.speak(u);
}

function openVoice() {
  $('#voiceStrip').hidden = false;
  if (!SR) { $('#voiceHeard').textContent = 'Speech recognition needs Chrome or Edge. You can still type commands.'; $('#voiceText').focus(); return; }
  if (listening) return;
  rec = new SR();
  rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = false;
  rec.onresult = e => {
    const r = e.results[e.results.length - 1];
    $('#voiceHeard').textContent = r[0].transcript;
    if (r.isFinal) handleCommand(r[0].transcript);
  };
  rec.onerror = e => { if (e.error === 'not-allowed') $('#voiceHeard').textContent = 'Microphone blocked. Allow it in the address bar, or type below.'; };
  rec.onend = () => { listening = false; $('#voiceBtn').classList.remove('live'); };
  rec.start(); listening = true; $('#voiceBtn').classList.add('live');
  $('#voiceHeard').textContent = 'Listening… try “route from Adyar to Guindy”';
}
function closeVoice() { $('#voiceStrip').hidden = true; if (rec && listening) rec.stop(); }

$('#voiceBtn').addEventListener('click', () => (listening ? rec.stop() : openVoice()));
$('#voiceClose').addEventListener('click', closeVoice);
$('#voiceTyped').addEventListener('submit', e => { e.preventDefault(); const t = $('#voiceText').value; $('#voiceText').value = ''; $('#voiceHeard').textContent = t; handleCommand(t); });
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'v' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); openVoice(); }
  if (e.key === 'Escape') closeVoice();
});

async function handleCommand(raw) {
  const t = raw.toLowerCase().replace(/[.?!]/g, '').trim();
  const cap = s => s.replace(/\b\w/g, c => c.toUpperCase()).trim();
  let m;
  const reply = msg => { $('#voiceHeard').textContent = '→ ' + msg; speak(msg); };

  if ((m = t.match(/from (.+?) to (.+)/))) {
    $('#from').value = cap(m[1]); $('#to').value = cap(m[2]); show('plan');
    reply(`Comparing routes from ${cap(m[1])} to ${cap(m[2])}.`);
    if (await plan($('#from').value, $('#to').value)) speak(describeComparison());
    return;
  }
  if ((m = t.match(/(?:take me|navigate|directions|route|go|drive|head) to (.+)/))) {
    $('#to').value = cap(m[1]); show('plan');
    reply(`Routing to ${cap(m[1])}.`);
    if (await plan($('#from').value, $('#to').value)) speak(describeComparison());
    return;
  }
  if (/switch to|i'?m (in|driving)|use (the )?(ev|electric|petrol|diesel|cng|van)/.test(t)) {
    const v = /ev|electric/.test(t) ? 'ev' : /diesel/.test(t) ? 'diesel' : /cng/.test(t) ? 'cng' : /van|delivery/.test(t) ? 'lcv' : /petrol/.test(t) ? 'petrol' : null;
    if (v) { $('#vehicle').value = v; $('#vehicle').dispatchEvent(new Event('change')); return reply(`Vehicle set to ${VEHICLES[v].name}.`); }
  }
  if (/(eco|green|cleanest|lowest)/.test(t) && !/how much/.test(t)) {
    if (!S.routes.length) return reply('Plan a route first.');
    select(S.routes.indexOf(S.eco)); return reply('Lower-emission route selected.');
  }
  if (/fastest|quickest|shortest time/.test(t)) {
    if (!S.routes.length) return reply('Plan a route first.');
    select(S.routes.indexOf(S.fast)); return reply('Fastest route selected. Your choice.');
  }
  if (/compare|difference|which route/.test(t)) return reply(describeComparison());
  if (/charg|battery/.test(t)) {
    if (S.vehicle !== 'ev') return reply('Charging guidance is for EVs. Say “switch to electric” first.');
    if (!S.routes.length) return reply('Plan a route first, then I can check charging.');
    show('plan'); await planCharging();
    const txt = $('#chargePanel').innerText.replace(/\s+/g, ' ');
    return reply(txt.slice(0, 220));
  }
  if (/pause/.test(t) && S.drive) { S.drive.paused = true; $('#dPause').textContent = 'Resume'; return reply('Paused.'); }
  if (/resume|continue/.test(t) && S.drive) { S.drive.paused = false; $('#dPause').textContent = 'Pause'; return reply('Resuming.'); }
  if (/(end|stop|finish).*(trip|drive|navigation)|^stop$/.test(t)) { if (S.drive) { endDrive(false); return; } return reply('No trip running.'); }
  if (/start|begin|let'?s go|drive/.test(t)) { if (!S.routes.length) return reply('Plan a route first.'); startDrive(); return; }
  if (/how much|total|saved|my (emission|carbon|co2)/.test(t)) {
    const co2 = S.trips.reduce((a, x) => a + x.co2, 0), saved = S.trips.reduce((a, x) => a + x.fastCo2 - x.co2, 0);
    return reply(S.trips.length ? `${S.trips.length} trips logged, about ${fmtKg(co2)} kilograms of CO2. Choosing eco routes avoided about ${fmtKg(saved)} kilograms.` : 'No trips logged yet.');
  }
  if ((m = t.match(/(?:open|show|go to) (?:the )?(plan|drive|log|dashboard|trips|fleet|method|privacy)/))) {
    const v = { dashboard: 'log', trips: 'log', privacy: 'method' }[m[1]] || m[1];
    show(v); return reply(`Opened ${v}.`);
  }
  if (/help|what can you/.test(t)) return reply('Try: route from Adyar to Guindy. Pick the eco route. Start driving. Switch to electric. Do I need to charge. How much have I saved.');
  reply(`Didn't catch a command in “${raw}”. Say “help” for examples.`);
}

// first load: plan the default trip so the screen isn't empty
plan($('#from').value, $('#to').value);
