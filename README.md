# Flight Orbit 3D Card

An interactive 3D aircraft map for Home Assistant, inspired by modern 3D flight trackers and powered by the existing [FlightRadar24 custom integration](https://github.com/AlexandrErohin/home-assistant-flightradar24).

The card reads the integration's `flights` and `bounds` attributes. It does not call FlightRadar24 directly and does not require another aircraft-data API key.

## Features

- Pitched 3D terrain with satellite and dark basemaps
- Aircraft displayed at the altitude supplied by FlightRadar24
- Heading-correct aircraft symbols
- Smooth interpolation between Home Assistant entity updates
- Flight trails from the integration's coordinate history
- Click-to-focus with controlled cinematic orbit
- Follow, focus, overview and fullscreen controls
- Callsign, route, aircraft, registration, altitude, speed, vertical speed and distance
- Separate airport ground-vehicle filter
- Emergency highlighting for squawk `7500`, `7600` and `7700` when squawk data is available
- Responsive layout for desktop, tablets and wall displays

## Requirements

- Home Assistant
- HACS
- [FlightRadar24 custom integration](https://github.com/AlexandrErohin/home-assistant-flightradar24)
- A working **Current in area** sensor containing `flights` and `bounds` attributes
- Internet access from the dashboard device for MapLibre, map tiles, terrain and aircraft photographs

The usual English entity ID is:

```text
sensor.flightradar24_current_in_area
```

Home Assistant can generate a different entity ID on systems using another language. Verify yours under **Developer Tools → States**.

## Install with HACS

1. Open **HACS**.
2. Open the three-dot menu and select **Custom repositories**.
3. Add this repository:

   ```text
   https://github.com/alpha520098/flight-orbit-3d-card
   ```

4. Select **Dashboard** as the category.
5. Install **Flight Orbit 3D Card**.
6. Refresh the Home Assistant frontend. Force-close and reopen the mobile app if required.

## Add the card

Add a Manual card to a dashboard:

```yaml
type: custom:flight-orbit-3d-card
entity: sensor.flightradar24_current_in_area
title: AIR TRAFFIC // SYDNEY
height: 700
map_style: satellite
show_ground: false
show_tracks: true
show_labels: true
actual_altitude: true
terrain: true
auto_orbit: true
auto_return_seconds: 0
focus_zoom: 10.8
focus_pitch: 72
orbit_seconds: 18
overview_pitch: 56
max_track_points: 160
```

The card also provides a visual configuration editor for its main settings.

## Controls

| Control | Action |
| --- | --- |
| **OVERVIEW** | Fits the camera to the configured FlightRadar24 bounds. |
| **AIR** | Returns to aircraft-only mode. |
| **VEH** | Shows or hides targets reported as airport ground vehicles. |
| **TRAILS** | Shows or hides coordinate-history trails. |
| **LABELS** | Shows or hides callsign and altitude labels. |
| **SAT/DARK** | Switches between satellite and dark map tiles. |
| **FULL** | Opens the card fullscreen. |
| **FOCUS** | Returns the camera to the selected aircraft. |
| **FOLLOW** | Keeps the camera centred on the selected aircraft. |
| **ORBIT** | Performs one controlled orbit around the selected aircraft. |

## Configuration

| Option | Default | Description |
| --- | ---: | --- |
| `entity` | required | FlightRadar24 Current in area sensor. |
| `title` | `AIR TRAFFIC // LIVE` | Card heading. |
| `height` | `700` | Card height in pixels, limited to 360–1600. |
| `map_style` | `satellite` | Initial style: `satellite` or `dark`. |
| `show_ground` | `false` | Include targets identified as airport ground vehicles. |
| `show_tracks` | `true` | Draw coordinate-history trails. |
| `show_labels` | `true` | Show callsign and altitude labels. |
| `actual_altitude` | `true` | Raise aircraft symbols by their supplied altitude. |
| `terrain` | `true` | Enable 3D terrain. |
| `auto_orbit` | `true` | Fly in and orbit after aircraft selection. |
| `auto_return_seconds` | `0` | Return to overview after an orbit; `0` disables it. |
| `focus_zoom` | `10.8` | Camera zoom when focusing. |
| `focus_pitch` | `72` | Camera pitch while focusing or orbiting. |
| `orbit_seconds` | `18` | Duration of one orbit. |
| `overview_pitch` | `56` | Overview camera pitch. |
| `max_track_points` | `160` | Maximum trail points rendered per aircraft. |

## Performance

Aircraft are rendered through MapLibre GeoJSON sources and symbol layers rather than separate HTML markers. Position interpolation is limited to roughly six updates per second and stops when animation is complete or the page is hidden.

Do not reduce the FlightRadar24 integration scan interval aggressively. FlightRadar24 rate-limits automated requests, and a shorter scan interval will not materially improve the card's interpolation.

## External map resources

The card loads MapLibre GL JS at runtime and uses third-party map and terrain services. The dashboard device must be able to reach:

- `unpkg.com`
- `tiles.mapterhorn.com`
- `server.arcgisonline.com`
- `basemaps.cartocdn.com`
- `demotiles.maplibre.org`

## Troubleshooting

### Custom element doesn't exist

Confirm HACS installed `flight-orbit-3d-card.js`, then clear the browser cache or force-close the Home Assistant app.

### Entity not found

Replace the example entity with the exact Current in area entity ID shown under **Developer Tools → States**.

### No aircraft displayed

Confirm the entity currently has a populated `flights` attribute. The integration can take several minutes to repopulate after a restart or reload.

### MapLibre could not load

Confirm the dashboard device can access the external map-resource domains listed above.

## Data and safety

Flight data may be delayed, incomplete or inaccurate. This card is for home dashboards and aviation interest only. Do not use it for navigation, flight planning or operational decisions.

## Licence

[MIT](LICENSE)
