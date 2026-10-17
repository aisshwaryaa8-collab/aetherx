# AetherX

**Sustainability-first navigation.** AetherX compares routes by estimated CO₂ as well as time, guides you by voice, plans EV charging stops, and tracks the emissions of every trip — for everyday drivers, EV owners and fleet operators.

---

## The problem

Google Maps and Waze optimise only for time and distance. Carbon calculators and voice assistants exist separately, but nothing combines eco-routing, emission tracking, charging guidance and fleet analytics in one place.

## Features

| Tab | What it does |
|---|---|
| **01 Plan** | Enter a start and destination. AetherX fetches real routes, estimates CO₂, fuel and cost for each, and shows the lowest-CO₂ route next to the fastest one (e.g. *+2 min, −8% CO₂, saves ₹15*). Choose vehicle type and departure time (peak / daytime / night). |
| **EV charging** | Select *Electric*, enter battery % and pack size. AetherX finds where charge drops to 20% and looks up real charging stations nearby. |
| **02 Drive** | Simulated drive with turn-by-turn spoken directions, live CO₂/fuel counters and eco-driving tips. Ending the trip saves it to the log. |
| **03 Log** | Personal emissions dashboard: totals, CO₂ avoided vs. always taking the fastest route, weekly chart, trip table, CSV export. |
| **04 Fleet** | Demo fleet of 12 vehicles: emissions per km, idling, eco-route adoption, sustainability score, automatic flags. |
| **05 Method** | The full emission formula, traffic factors and data-privacy notes. |
| **Voice** | Click *Voice* or press **V**. Try: *"route from Adyar to Guindy"*, *"pick the eco route"*, *"start driving"*, *"switch to electric"*, *"do I need to charge?"*, *"how much have I saved?"*. |

## How emissions are estimated

```
CO₂(step) = distance_km × base_factor × speed_curve(speed) × stop_penalty
```

- Each route is split into steps; the average speed of each step comes from the routing engine, adjusted by a typical-traffic model for the chosen departure time.
- `speed_curve` is U-shaped, lowest around 60 km/h — crawling traffic and very high speeds both cost more per km.
- Fuel = CO₂ ÷ fuel factor (petrol 2.31, diesel 2.68 kg CO₂/L; grid 0.71 kg CO₂/kWh).

All figures are **estimates** and are labelled that way in the app.

## Responsible use

- **Driver choice:** the eco route is a suggestion; the fastest route is always shown and selectable.
- **Privacy:** location is read only when you press ◎ (with browser permission) and is not stored. Trips are kept in your browser's local storage only — nothing is uploaded. *Clear my data* deletes them.
- **Transparency:** the Method tab shows exactly how every number is calculated.
- **Safety:** spoken guidance keeps eyes on the road.

## Tech

Plain HTML, CSS and JavaScript — no build step, no API keys.

- [Leaflet](https://leafletjs.com) for maps, with [OpenStreetMap](https://www.openstreetmap.org) tiles
- [OSRM](https://project-osrm.org) for routing
- [Nominatim](https://nominatim.org) for place search
- [Overpass API](https://overpass-api.de) for EV charging stations
- Web Speech API for voice input and spoken guidance (works best in Chrome or Edge)

## Run locally

```bash
git clone https://github.com/aisshwaryaa8-collab/aetherx.git
cd aetherx
python -m http.server 5173
```

Open http://localhost:5173. An internet connection is needed for maps and routing.

## Limitations

- Traffic is a modelled time-of-day pattern, not live traffic.
- Drive mode is a simulation, not real GPS navigation.
- Fleet data is generated demo data.
- The public routing and map services are rate-limited; heavy use can be slow.
