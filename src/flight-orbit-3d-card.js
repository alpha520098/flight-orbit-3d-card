/*
 * Flight Orbit 3D Card for Home Assistant
 * Version 1.0.2
 *
 * Data source: AlexandrErohin/home-assistant-flightradar24
 * Map renderer: MapLibre GL JS 6.6.0 (bundled)
 */

const CARD_VERSION = "1.0.2";
const MAPLIBRE_CSS_TEXT = "__MAPLIBRE_CSS__";
const MAP_BOOT_TIMEOUT_MS = 10000;
const EMPTY_COLLECTION = Object.freeze({ type: "FeatureCollection", features: [] });

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

class FlightOrbit3DCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("flight-orbit-3d-card-editor");
  }

  static getStubConfig() {
    return {
      entity: "sensor.flightradar24_current_in_area",
      title: "AIR TRAFFIC // SYDNEY",
      height: 700,
      map_style: "satellite",
      show_ground: false,
      show_tracks: true,
      show_labels: true,
      actual_altitude: true,
      auto_orbit: true,
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._maplibre = null;
    this._map = null;
    this._mapReady = false;
    this._booting = false;
    this._lastEntity = null;
    this._lastUpdated = 0;
    this._flights = [];
    this._displayFlights = [];
    this._renderPositions = new Map();
    this._animationTargets = new Map();
    this._animationTimer = null;
    this._selectedId = null;
    this._followSelected = false;
    this._showGround = false;
    this._showTracks = true;
    this._showLabels = true;
    this._mapStyle = "satellite";
    this._layerHandlersBound = false;
    this._motionToken = 0;
    this._orbitFrame = null;
    this._autoReturnTimer = null;
    this._resizeObserver = null;
    this._documentVisibilityHandler = null;
    this._statusTimer = null;
    this._bootTimer = null;
    this._terrainFallback = false;
  }

  connectedCallback() {
    if (this._config && this.shadowRoot.firstChild && !this._map && !this._booting) {
      this._bootMap();
    }
  }

  setConfig(config) {
    if (!config?.entity) {
      throw new Error("Flight Orbit 3D Card requires a FlightRadar24 Current in area entity.");
    }

    this._config = {
      title: "AIR TRAFFIC // LIVE",
      height: 700,
      map_style: "satellite",
      show_ground: false,
      show_tracks: true,
      show_labels: true,
      actual_altitude: true,
      terrain: true,
      auto_orbit: true,
      auto_return_seconds: 0,
      focus_zoom: 10.8,
      focus_pitch: 72,
      orbit_seconds: 18,
      overview_pitch: 56,
      max_track_points: 160,
      ...config,
    };

    this._showGround = Boolean(this._config.show_ground);
    this._showTracks = Boolean(this._config.show_tracks);
    this._showLabels = Boolean(this._config.show_labels);
    this._mapStyle = this._config.map_style === "dark" ? "dark" : "satellite";
    this._terrainFallback = false;

    if (!this.shadowRoot.firstChild) {
      this._renderShell();
      if (this.isConnected) this._bootMap();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;

    const entity = hass.states[this._config.entity];
    if (!entity) {
      this._setStatus(`ENTITY NOT FOUND: ${this._config.entity}`, true);
      return;
    }

    if (entity === this._lastEntity) return;
    this._lastEntity = entity;
    this._ingestEntity(entity);
  }

  getCardSize() {
    return Math.max(5, Math.ceil(finite(this._config?.height, 700) / 50));
  }

  disconnectedCallback() {
    this._stopMotion();
    this._stopInterpolation();
    if (this._statusTimer) clearTimeout(this._statusTimer);
    if (this._bootTimer) clearTimeout(this._bootTimer);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._documentVisibilityHandler) {
      document.removeEventListener("visibilitychange", this._documentVisibilityHandler);
    }
    if (this._map) {
      this._map.remove();
      this._map = null;
      this._mapReady = false;
      this._layerHandlersBound = false;
    }
  }

  _renderShell() {
    const height = clamp(finite(this._config.height, 700), 360, 1600);
    this.shadowRoot.innerHTML = `
      <style>
        ${MAPLIBRE_CSS_TEXT}
        :host {
          display: block;
          --panel: rgba(7, 14, 24, 0.88);
          --panel-line: rgba(126, 214, 255, 0.22);
          --cyan: #59dcff;
          --green: #7dffb2;
          --amber: #ffc65c;
          --red: #ff4d5e;
          --muted: #9aa8b8;
          font-family: Inter, Roboto, system-ui, sans-serif;
        }
        ha-card {
          position: relative;
          height: ${height}px;
          min-height: 360px;
          overflow: hidden;
          border-radius: var(--ha-card-border-radius, 16px);
          background: #050a10;
          color: #eef7ff;
        }
        #map, .boot-shade, .scanlines { position: absolute; inset: 0; }
        #map { background: radial-gradient(circle at 50% 42%, #142337, #05080e 72%); }
        .boot-shade {
          z-index: 30;
          display: grid;
          place-items: center;
          background: radial-gradient(circle at 50% 50%, rgba(16, 40, 62, .78), rgba(2, 6, 11, .97));
          transition: opacity .35s ease;
          pointer-events: none;
        }
        .boot-shade.ready { opacity: 0; }
        .boot-box { text-align: center; letter-spacing: .16em; font-weight: 800; }
        .radar-loader {
          width: 68px; height: 68px; margin: 0 auto 18px; border-radius: 50%;
          border: 1px solid rgba(89, 220, 255, .28);
          background: conic-gradient(from 0deg, transparent 0 78%, rgba(89,220,255,.95));
          animation: spin 1.2s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .scanlines {
          z-index: 3;
          opacity: .08;
          pointer-events: none;
          background: repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,.28) 4px);
        }
        .topbar {
          position: absolute; z-index: 10; left: 14px; right: 14px; top: 14px;
          display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
          pointer-events: none;
        }
        .titlebox, .controls, .detail, .status, .legend {
          background: var(--panel); border: 1px solid var(--panel-line);
          box-shadow: 0 12px 35px rgba(0,0,0,.30); backdrop-filter: blur(12px);
        }
        .titlebox { padding: 10px 13px; border-radius: 10px; min-width: 210px; }
        .title { font-size: 13px; font-weight: 900; letter-spacing: .14em; }
        .summary { margin-top: 5px; color: var(--muted); font-size: 11px; letter-spacing: .06em; }
        .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 12px var(--green); margin-right: 7px; }
        .controls { pointer-events: auto; padding: 6px; border-radius: 10px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; max-width: min(520px, 58vw); }
        button {
          border: 1px solid rgba(255,255,255,.13); border-radius: 7px; padding: 7px 9px;
          background: rgba(255,255,255,.055); color: #dcecff; cursor: pointer;
          font: 800 10px/1 Inter, Roboto, sans-serif; letter-spacing: .08em;
        }
        button:hover { border-color: rgba(89,220,255,.58); background: rgba(89,220,255,.13); }
        button.active { color: #061018; border-color: var(--cyan); background: var(--cyan); }
        button.danger.active { color: #fff; border-color: var(--red); background: rgba(255,77,94,.84); }
        .detail {
          position: absolute; z-index: 12; left: 14px; bottom: 14px; width: min(390px, calc(100% - 28px));
          border-radius: 12px; overflow: hidden; transform: translateY(calc(100% + 30px));
          opacity: 0; transition: transform .28s ease, opacity .2s ease; pointer-events: none;
        }
        .detail.open { transform: translateY(0); opacity: 1; pointer-events: auto; }
        .detail-head { display: grid; grid-template-columns: 92px 1fr auto; min-height: 78px; }
        .detail-photo { width: 92px; height: 78px; object-fit: cover; background: #111b26; }
        .detail-ident { padding: 11px 12px 8px; min-width: 0; }
        .callsign { font-size: 18px; line-height: 1; font-weight: 950; letter-spacing: .06em; }
        .route { margin-top: 7px; color: var(--cyan); font-weight: 850; font-size: 13px; }
        .model { margin-top: 5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
        .close { width: 32px; height: 32px; margin: 6px; padding: 0; border-radius: 50%; }
        .metrics { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid var(--panel-line); }
        .metric { padding: 9px 8px; border-right: 1px solid var(--panel-line); }
        .metric:last-child { border-right: 0; }
        .metric-label { color: var(--muted); font-size: 9px; letter-spacing: .08em; }
        .metric-value { margin-top: 3px; font-size: 12px; font-weight: 900; white-space: nowrap; }
        .detail-actions { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--panel-line); }
        .detail-actions button { flex: 1; }
        .status {
          position: absolute; z-index: 14; left: 50%; bottom: 18px; transform: translate(-50%, 20px);
          padding: 8px 12px; border-radius: 8px; font-size: 10px; font-weight: 850; letter-spacing: .08em;
          opacity: 0; transition: .2s ease; pointer-events: none;
        }
        .status.show { opacity: 1; transform: translate(-50%, 0); }
        .status.error { border-color: rgba(255,77,94,.65); color: #ffd9dd; }
        .legend {
          position: absolute; z-index: 8; right: 14px; bottom: 14px; border-radius: 8px;
          padding: 7px 9px; color: var(--muted); font-size: 9px; letter-spacing: .06em;
          pointer-events: none;
        }
        .legend i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin: 0 4px 0 8px; }
        .legend i:first-child { margin-left: 0; }
        .maplibregl-ctrl-bottom-left, .maplibregl-ctrl-bottom-right { opacity: .58; }
        .maplibregl-ctrl-attrib { font-size: 9px; }
        @media (max-width: 700px) {
          .topbar { left: 8px; right: 8px; top: 8px; display: block; }
          .titlebox { display: inline-block; min-width: 0; }
          .controls { margin-top: 6px; max-width: 100%; justify-content: flex-start; }
          button { padding: 7px 8px; font-size: 9px; }
          .legend { display: none; }
          .detail { left: 8px; bottom: 8px; width: calc(100% - 16px); }
          .metrics { grid-template-columns: repeat(2, 1fr); }
          .metric:nth-child(2) { border-right: 0; }
          .metric:nth-child(-n+2) { border-bottom: 1px solid var(--panel-line); }
        }
      </style>
      <ha-card>
        <div id="map"></div>
        <div class="scanlines"></div>
        <div class="topbar">
          <div class="titlebox">
            <div class="title">${escapeHtml(this._config.title)}</div>
            <div class="summary"><span class="live-dot"></span><span id="summary">INITIALISING</span></div>
          </div>
          <div class="controls">
            <button id="overview">OVERVIEW</button>
            <button id="air" class="active">AIR</button>
            <button id="ground">VEH</button>
            <button id="tracks">TRAILS</button>
            <button id="labels">LABELS</button>
            <button id="style">SAT</button>
            <button id="fullscreen">FULL</button>
          </div>
        </div>
        <section id="detail" class="detail"></section>
        <div id="status" class="status"></div>
        <div class="legend"><i style="background:#59dcff"></i>AIRBORNE <i style="background:#ffc65c"></i>GROUND <i style="background:#ff4d5e"></i>EMERGENCY</div>
        <div id="boot" class="boot-shade"><div class="boot-box"><div class="radar-loader"></div><div id="boot-text">LOADING 3D AIRSPACE</div></div></div>
      </ha-card>
    `;

    this._wireUi();
  }

  _wireUi() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    $("overview").addEventListener("click", () => this._showOverview());
    $("air").addEventListener("click", () => {
      this._showGround = false;
      $("air").classList.add("active");
      $("ground").classList.remove("active");
      this._applyData();
    });
    $("ground").addEventListener("click", () => {
      this._showGround = !this._showGround;
      $("ground").classList.toggle("active", this._showGround);
      this._applyData();
    });
    $("tracks").addEventListener("click", () => {
      this._showTracks = !this._showTracks;
      $("tracks").classList.toggle("active", this._showTracks);
      this._setLayerVisibility("flight-tracks", this._showTracks);
    });
    $("labels").addEventListener("click", () => {
      this._showLabels = !this._showLabels;
      $("labels").classList.toggle("active", this._showLabels);
      this._setLayerVisibility("flight-labels", this._showLabels);
    });
    $("style").addEventListener("click", () => this._toggleStyle());
    $("fullscreen").addEventListener("click", () => this._toggleFullscreen());
    $("tracks").classList.toggle("active", this._showTracks);
    $("labels").classList.toggle("active", this._showLabels);
    $("ground").classList.toggle("active", this._showGround);
    $("style").textContent = this._mapStyle === "satellite" ? "SAT" : "DARK";
  }

  async _bootMap() {
    if (this._booting || this._map) return;
    this._booting = true;
    const bootText = this.shadowRoot.getElementById("boot-text");
    const boot = this.shadowRoot.getElementById("boot");
    if (bootText) bootText.textContent = "LOADING 3D AIRSPACE";
    if (boot) {
      boot.style.display = "grid";
      boot.classList.remove("ready");
    }
    try {
      if (!globalThis.WebGLRenderingContext) {
        throw new Error("This device does not support WebGL.");
      }
      const module = await globalThis.maplibreglReady;
      if (!module?.Map) throw new Error("Bundled MapLibre failed to initialise.");
      this._maplibre = module;
      if (!this.isConnected) return;

      this._map = new module.Map({
        container: this.shadowRoot.getElementById("map"),
        style: this._buildMapStyle(this._mapStyle),
        center: [150.76, -34.05],
        zoom: 7.6,
        pitch: finite(this._config.overview_pitch, 56),
        bearing: -18,
        maxPitch: 85,
        maxZoom: 19,
        antialias: true,
        attributionControl: true,
        fadeDuration: 0,
        canvasContextAttributes: { antialias: true },
      });

      this._map.addControl(new module.NavigationControl({ visualizePitch: true }), "bottom-right");
      // The full `load` event waits for every visible tile. A slow or blocked
      // third-party tile server can therefore leave the boot shade up forever.
      // `style.load` is sufficient for installing our sources and layers.
      this._map.once("style.load", () => this._onMapLoad());
      this._map.on("error", (event) => {
        const message = event?.error?.message || "Map tile error";
        if (!/abort|cancel/i.test(message)) this._setStatus(message, true, 3500);
      });

      this._resizeObserver = new ResizeObserver(() => this._map?.resize());
      this._resizeObserver.observe(this.shadowRoot.querySelector("ha-card"));
      this._documentVisibilityHandler = () => {
        if (document.hidden) {
          this._stopMotion();
          this._stopInterpolation();
        } else {
          this._map?.resize();
          this._startInterpolation();
          if (this._followSelected) this._focusSelected(false);
        }
      };
      document.addEventListener("visibilitychange", this._documentVisibilityHandler);

      this._armBootTimeout(bootText);
    } catch (error) {
      if (bootText) bootText.textContent = `MAP FAILED: ${error.message}`;
      this._setStatus("MapLibre could not load. Check this dashboard device has internet access.", true, 0);
    } finally {
      this._booting = false;
    }
  }

  _armBootTimeout(bootText) {
    if (this._bootTimer) clearTimeout(this._bootTimer);
    this._bootTimer = setTimeout(() => {
      if (this._mapReady) return;
      if (this._map?.isStyleLoaded()) {
        this._onMapLoad();
        return;
      }
      if (this._config.terrain !== false && !this._terrainFallback && this._map) {
        this._terrainFallback = true;
        if (bootText) bootText.textContent = "TERRAIN UNAVAILABLE — LOADING MAP";
        this._map.once("style.load", () => this._onMapLoad());
        this._map.setStyle(this._buildMapStyle(this._mapStyle));
        this._armBootTimeout(bootText);
        return;
      }
      if (bootText) bootText.textContent = "MAP RESOURCES TIMED OUT";
      this._setStatus("Map startup timed out. Check access to the map-resource domains.", true, 0);
    }, MAP_BOOT_TIMEOUT_MS);
  }

  _buildMapStyle(mode) {
    const satellite = mode === "satellite";
    const terrainEnabled = this._config.terrain !== false && !this._terrainFallback;
    const baseTiles = satellite
      ? ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"]
      : ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png", "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png"];

    const style = {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {
        basemap: {
          type: "raster",
          tiles: baseTiles,
          tileSize: satellite ? 256 : 512,
          maxzoom: 19,
          attribution: satellite ? "Tiles © Esri" : "© OpenStreetMap © CARTO",
        },
      },
      layers: [
        { id: "basemap", type: "raster", source: "basemap", paint: { "raster-saturation": satellite ? -0.18 : -0.65, "raster-contrast": satellite ? 0.12 : 0.2, "raster-brightness-max": satellite ? 0.78 : 0.68 } },
      ],
      sky: {},
    };
    if (terrainEnabled) {
      style.sources.terrainSource = {
        type: "raster-dem",
        url: "https://tiles.mapterhorn.com/tilejson.json",
        tileSize: 512,
      };
      style.layers.push({ id: "terrain-shade", type: "hillshade", source: "terrainSource", paint: { "hillshade-exaggeration": satellite ? 0.32 : 0.55, "hillshade-shadow-color": "#03101a", "hillshade-highlight-color": satellite ? "#9fcde4" : "#4b8da6" } });
      style.terrain = { source: "terrainSource", exaggeration: 1.15 };
    }
    return style;
  }

  _onMapLoad() {
    if (this._mapReady) return;
    if (this._bootTimer) {
      clearTimeout(this._bootTimer);
      this._bootTimer = null;
    }
    this._mapReady = true;
    this._installAircraftImages();
    this._installFlightLayers();
    this._applyData();
    this._showOverview(false);
    const boot = this.shadowRoot.getElementById("boot");
    boot?.classList.add("ready");
    setTimeout(() => {
      if (boot) boot.style.display = "none";
    }, 500);
    this._setStatus("3D AIRSPACE ONLINE", false, 1800);
  }

  _installAircraftImages() {
    const icons = {
      "plane-air": this._makePlaneIcon("#59dcff", "rgba(89,220,255,.24)"),
      "plane-ground": this._makePlaneIcon("#ffc65c", "rgba(255,198,92,.22)"),
      "plane-emergency": this._makePlaneIcon("#ff4d5e", "rgba(255,77,94,.35)"),
      "selected-ring": this._makeRingIcon(),
    };
    for (const [name, canvas] of Object.entries(icons)) {
      if (!this._map.hasImage(name)) this._map.addImage(name, canvas, { pixelRatio: 2 });
    }
  }

  _makePlaneIcon(color, glow) {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext("2d");
    context.translate(48, 48);
    context.shadowColor = glow;
    context.shadowBlur = 12;
    context.fillStyle = color;
    context.strokeStyle = "rgba(3,11,18,.9)";
    context.lineWidth = 2.4;
    const path = new Path2D("M 0 -41 C 4 -35 5 -24 6 -12 L 34 7 L 34 14 L 6 6 L 5 27 L 16 35 L 16 41 L 0 35 L -16 41 L -16 35 L -5 27 L -6 6 L -34 14 L -34 7 L -6 -12 C -5 -24 -4 -35 0 -41 Z");
    context.fill(path);
    context.stroke(path);
    return canvas;
  }

  _makeRingIcon() {
    const canvas = document.createElement("canvas");
    canvas.width = 112;
    canvas.height = 112;
    const context = canvas.getContext("2d");
    context.strokeStyle = "rgba(255,255,255,.92)";
    context.lineWidth = 4;
    context.setLineDash([7, 7]);
    context.beginPath();
    context.arc(56, 56, 43, 0, Math.PI * 2);
    context.stroke();
    return canvas;
  }

  _installFlightLayers() {
    this._map.addSource("flight-points", { type: "geojson", data: EMPTY_COLLECTION });
    this._map.addSource("flight-trails", { type: "geojson", data: EMPTY_COLLECTION, lineMetrics: true });

    this._map.addLayer({
      id: "flight-tracks",
      type: "line",
      source: "flight-trails",
      layout: { visibility: this._showTracks ? "visible" : "none", "line-cap": "round", "line-join": "round" },
      paint: {
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 12, 2.5],
        "line-opacity": ["case", ["==", ["get", "selected"], 1], 0.95, 0.55],
        "line-color": ["case", ["==", ["get", "emergency"], 1], "#ff4d5e", ["==", ["get", "onGround"], 1], "#ffc65c", "#59dcff"],
      },
    });

    const commonSymbol = {
      "symbol-placement": "point",
      "symbol-height-offset": this._config.actual_altitude === false ? 0 : ["get", "heightMeters"],
      "icon-rotation-alignment": "map",
      "icon-pitch-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    };

    this._map.addLayer({
      id: "selected-aircraft-ring",
      type: "symbol",
      source: "flight-points",
      filter: ["==", ["get", "id"], "__none__"],
      layout: { ...commonSymbol, "icon-image": "selected-ring", "icon-size": ["interpolate", ["linear"], ["zoom"], 5, .22, 12, .45] },
    });

    this._map.addLayer({
      id: "aircraft-symbols",
      type: "symbol",
      source: "flight-points",
      layout: {
        ...commonSymbol,
        "icon-image": ["case", ["==", ["get", "emergency"], 1], "plane-emergency", ["==", ["get", "onGround"], 1], "plane-ground", "plane-air"],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 5, .18, 9, .27, 13, .40, 17, .54],
        "icon-rotate": ["get", "heading"],
      },
    });

    this._map.addLayer({
      id: "flight-labels",
      type: "symbol",
      source: "flight-points",
      minzoom: 7,
      layout: {
        "symbol-placement": "point",
        "symbol-height-offset": this._config.actual_altitude === false ? 0 : ["get", "heightMeters"],
        "text-field": ["get", "mapLabel"],
        "text-font": ["Open Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, 9, 13, 12],
        "text-offset": [0, 2.1],
        "text-anchor": "top",
        "text-allow-overlap": false,
        "visibility": this._showLabels ? "visible" : "none",
      },
      paint: { "text-color": "#eff8ff", "text-halo-color": "rgba(3,10,17,.95)", "text-halo-width": 1.5, "text-halo-blur": .6 },
    });

    if (!this._layerHandlersBound) {
      this._map.on("mouseenter", "aircraft-symbols", () => { this._map.getCanvas().style.cursor = "pointer"; });
      this._map.on("mouseleave", "aircraft-symbols", () => { this._map.getCanvas().style.cursor = ""; });
      this._map.on("click", "aircraft-symbols", (event) => {
        const id = String(event.features?.[0]?.properties?.id ?? "");
        if (id) this._selectFlight(id, true);
      });
      this._layerHandlersBound = true;
    }
  }

  _ingestEntity(entity) {
    const incoming = Array.isArray(entity.attributes?.flights) ? entity.attributes.flights : [];
    const now = performance.now();
    const elapsed = this._lastUpdated ? now - this._lastUpdated : 8000;
    this._lastUpdated = now;
    this._flights = incoming
      .filter((flight) => Number.isFinite(Number(flight.latitude)) && Number.isFinite(Number(flight.longitude)))
      .map((flight) => this._normaliseFlight(flight));

    const ids = new Set(this._flights.map((flight) => flight.id));
    if (this._selectedId && !ids.has(this._selectedId)) this._closeDetails();

    const duration = clamp(elapsed * 0.82, 1400, 12000);
    for (const flight of this._flights) {
      const previous = this._renderPositions.get(flight.id) || { latitude: flight.latitude, longitude: flight.longitude };
      const distance = this._distanceKm(previous.latitude, previous.longitude, flight.latitude, flight.longitude);
      this._animationTargets.set(flight.id, {
        fromLat: distance > 100 ? flight.latitude : previous.latitude,
        fromLon: distance > 100 ? flight.longitude : previous.longitude,
        toLat: flight.latitude,
        toLon: flight.longitude,
        started: now,
        duration,
      });
    }
    for (const id of this._renderPositions.keys()) {
      if (!ids.has(id)) this._renderPositions.delete(id);
    }

    this._updateSummary();
    this._applyData();
    this._startInterpolation();
    if (this._selectedId) this._renderDetails();
  }

  _normaliseFlight(flight) {
    const callsign = flight.callsign || flight.flight_number || flight.aircraft_registration || "UNKNOWN";
    const squawk = String(flight.squawk || "").padStart(4, "0");
    const onGround = Number(flight.on_ground) === 1 || Number(flight.altitude) <= 0;
    const groundVehicle = flight.aircraft_code === "GRND" || /ground vehicle/i.test(flight.aircraft_model || "");
    const emergency = ["7500", "7600", "7700"].includes(squawk);
    const altitude = Math.max(0, finite(flight.altitude));
    return {
      ...flight,
      id: String(flight.id || flight.aircraft_icao_24bit || `${callsign}-${flight.latitude}-${flight.longitude}`),
      callsign,
      latitude: finite(flight.latitude),
      longitude: finite(flight.longitude),
      altitude,
      heightMeters: Math.round(altitude * 0.3048),
      heading: ((finite(flight.heading) % 360) + 360) % 360,
      ground_speed: Math.max(0, finite(flight.ground_speed)),
      vertical_speed: finite(flight.vertical_speed),
      onGround,
      groundVehicle,
      emergency,
      squawk,
      coordinates: Array.isArray(flight.coordinates) ? flight.coordinates : [],
    };
  }

  _filteredFlights() {
    return this._flights.filter((flight) => !flight.groundVehicle || this._showGround);
  }

  _applyData() {
    if (!this._mapReady || !this._map) return;
    this._displayFlights = this._filteredFlights();
    const points = this._pointCollection(this._displayFlights);
    const trails = this._trailCollection(this._displayFlights);
    this._map.getSource("flight-points")?.setData(points);
    this._map.getSource("flight-trails")?.setData(trails);
    this._setLayerVisibility("flight-tracks", this._showTracks);
    this._setLayerVisibility("flight-labels", this._showLabels);
    this._updateSelectionFilter();
  }

  _pointCollection(flights) {
    return {
      type: "FeatureCollection",
      features: flights.map((flight) => {
        const position = this._renderPositions.get(flight.id) || flight;
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [position.longitude, position.latitude] },
          properties: {
            id: flight.id,
            heading: flight.heading,
            heightMeters: flight.onGround ? 2 : flight.heightMeters,
            onGround: flight.onGround ? 1 : 0,
            emergency: flight.emergency ? 1 : 0,
            mapLabel: `${flight.callsign}  ${flight.altitude.toLocaleString()} FT`,
          },
        };
      }),
    };
  }

  _trailCollection(flights) {
    const limit = clamp(finite(this._config.max_track_points, 160), 10, 500);
    return {
      type: "FeatureCollection",
      features: flights
        .filter((flight) => flight.coordinates.length > 1)
        .map((flight) => ({
          type: "Feature",
          properties: { id: flight.id, selected: flight.id === this._selectedId ? 1 : 0, emergency: flight.emergency ? 1 : 0, onGround: flight.onGround ? 1 : 0 },
          geometry: {
            type: "LineString",
            coordinates: flight.coordinates.slice(-limit)
              .map((coordinate) => [finite(coordinate?.[1], NaN), finite(coordinate?.[0], NaN)])
              .filter((coordinate) => coordinate.every(Number.isFinite)),
          },
        }))
        .filter((feature) => feature.geometry.coordinates.length > 1),
    };
  }

  _startInterpolation() {
    if (document.hidden || this._animationTimer || !this._flights.length) return;
    this._animationTimer = setInterval(() => this._interpolatePositions(), 160);
  }

  _stopInterpolation() {
    if (this._animationTimer) clearInterval(this._animationTimer);
    this._animationTimer = null;
  }

  _interpolatePositions() {
    if (!this._mapReady) return;
    const now = performance.now();
    let active = false;
    for (const flight of this._flights) {
      const target = this._animationTargets.get(flight.id);
      if (!target) continue;
      const t = clamp((now - target.started) / target.duration, 0, 1);
      const eased = t * t * (3 - 2 * t);
      this._renderPositions.set(flight.id, {
        latitude: target.fromLat + (target.toLat - target.fromLat) * eased,
        longitude: target.fromLon + (target.toLon - target.fromLon) * eased,
      });
      if (t < 1) active = true;
    }
    this._map.getSource("flight-points")?.setData(this._pointCollection(this._displayFlights));
    if (this._followSelected) this._trackSelectedCamera();
    if (!active) this._stopInterpolation();
  }

  _updateSummary() {
    const air = this._flights.filter((flight) => !flight.onGround && !flight.groundVehicle).length;
    const ground = this._flights.filter((flight) => flight.onGround && !flight.groundVehicle).length;
    const vehicles = this._flights.filter((flight) => flight.groundVehicle).length;
    const emergency = this._flights.filter((flight) => flight.emergency).length;
    const alert = emergency ? ` // ${emergency} ALERT` : "";
    const summary = this.shadowRoot.getElementById("summary");
    if (summary) summary.textContent = `${air} AIRBORNE // ${ground} GROUND // ${vehicles} VEHICLES${alert}`;
  }

  _selectFlight(id, focus) {
    const flight = this._flights.find((item) => item.id === id);
    if (!flight) return;
    this._selectedId = id;
    this._followSelected = false;
    this._updateSelectionFilter();
    this._applyData();
    this._renderDetails();
    if (focus) this._focusSelected(Boolean(this._config.auto_orbit));
  }

  _renderDetails() {
    const flight = this._flights.find((item) => item.id === this._selectedId);
    const detail = this.shadowRoot.getElementById("detail");
    if (!flight || !detail) return;
    const origin = flight.airport_origin_code_iata || flight.airport_origin_code_icao || "---";
    const destination = flight.airport_destination_code_iata || flight.airport_destination_code_icao || "---";
    const photo = flight.aircraft_photo_medium || flight.aircraft_photo_small || "";
    const climb = flight.vertical_speed > 100 ? `▲ ${Math.round(flight.vertical_speed)} FPM` : flight.vertical_speed < -100 ? `▼ ${Math.abs(Math.round(flight.vertical_speed))} FPM` : "LEVEL";
    detail.innerHTML = `
      <div class="detail-head">
        ${photo ? `<img class="detail-photo" src="${escapeHtml(photo)}" alt="Aircraft">` : `<div class="detail-photo"></div>`}
        <div class="detail-ident">
          <div class="callsign">${escapeHtml(flight.callsign)}${flight.emergency ? " ⚠" : ""}</div>
          <div class="route">${escapeHtml(origin)} → ${escapeHtml(destination)}</div>
          <div class="model">${escapeHtml(flight.aircraft_model || "Aircraft")} // ${escapeHtml(flight.aircraft_registration || "NO REG")}</div>
        </div>
        <button id="close-detail" class="close">×</button>
      </div>
      <div class="metrics">
        <div class="metric"><div class="metric-label">ALTITUDE</div><div class="metric-value">${flight.altitude.toLocaleString()} FT</div></div>
        <div class="metric"><div class="metric-label">SPEED</div><div class="metric-value">${Math.round(flight.ground_speed)} KT</div></div>
        <div class="metric"><div class="metric-label">VERTICAL</div><div class="metric-value">${escapeHtml(climb)}</div></div>
        <div class="metric"><div class="metric-label">DISTANCE</div><div class="metric-value">${finite(flight.distance).toFixed(1)} KM</div></div>
      </div>
      <div class="detail-actions">
        <button id="focus-flight">FOCUS</button>
        <button id="follow-flight" class="${this._followSelected ? "active" : ""}">FOLLOW</button>
        <button id="orbit-flight">ORBIT</button>
      </div>`;
    detail.classList.add("open");
    detail.querySelector("#close-detail").addEventListener("click", () => this._closeDetails());
    detail.querySelector("#focus-flight").addEventListener("click", () => this._focusSelected(false));
    detail.querySelector("#follow-flight").addEventListener("click", () => {
      this._stopMotion();
      this._followSelected = !this._followSelected;
      this._renderDetails();
      if (this._followSelected) this._focusSelected(false);
    });
    detail.querySelector("#orbit-flight").addEventListener("click", () => this._startOrbit());
  }

  _closeDetails() {
    this._stopMotion();
    this._followSelected = false;
    this._selectedId = null;
    this._updateSelectionFilter();
    this.shadowRoot.getElementById("detail")?.classList.remove("open");
    this._applyData();
  }

  _focusSelected(startOrbit) {
    const flight = this._flights.find((item) => item.id === this._selectedId);
    if (!flight || !this._map) return;
    this._stopMotion();
    const position = this._renderPositions.get(flight.id) || flight;
    const token = ++this._motionToken;
    this._map.flyTo({
      center: [position.longitude, position.latitude],
      zoom: finite(this._config.focus_zoom, 10.8),
      pitch: finite(this._config.focus_pitch, 72),
      bearing: flight.heading - 25,
      duration: 2600,
      essential: true,
    });
    if (startOrbit) {
      this._map.once("moveend", () => {
        if (token === this._motionToken && this._selectedId) this._startOrbit();
      });
    }
  }

  _startOrbit() {
    const flight = this._flights.find((item) => item.id === this._selectedId);
    if (!flight || !this._map) return;
    this._stopMotion();
    this._followSelected = false;
    this._renderDetails();
    const token = ++this._motionToken;
    const started = performance.now();
    const duration = clamp(finite(this._config.orbit_seconds, 18), 6, 90) * 1000;
    const startBearing = this._map.getBearing();

    const frame = (now) => {
      if (token !== this._motionToken || !this._selectedId || document.hidden) return;
      const current = this._flights.find((item) => item.id === this._selectedId);
      if (!current) return;
      const position = this._renderPositions.get(current.id) || current;
      const progress = clamp((now - started) / duration, 0, 1);
      this._map.jumpTo({ center: [position.longitude, position.latitude], bearing: startBearing + progress * 360, pitch: finite(this._config.focus_pitch, 72) });
      if (progress < 1) {
        this._orbitFrame = requestAnimationFrame(frame);
      } else {
        this._orbitFrame = null;
        this._scheduleAutoReturn();
      }
    };
    this._orbitFrame = requestAnimationFrame(frame);
  }

  _trackSelectedCamera() {
    const flight = this._flights.find((item) => item.id === this._selectedId);
    if (!flight || !this._map) return;
    const position = this._renderPositions.get(flight.id) || flight;
    this._map.jumpTo({ center: [position.longitude, position.latitude] });
  }

  _scheduleAutoReturn() {
    const seconds = finite(this._config.auto_return_seconds, 0);
    if (seconds <= 0) return;
    this._autoReturnTimer = setTimeout(() => this._showOverview(), seconds * 1000);
  }

  _stopMotion() {
    this._motionToken += 1;
    if (this._orbitFrame) cancelAnimationFrame(this._orbitFrame);
    if (this._autoReturnTimer) clearTimeout(this._autoReturnTimer);
    this._orbitFrame = null;
    this._autoReturnTimer = null;
    this._map?.stop();
  }

  _showOverview(animated = true) {
    if (!this._map) return;
    this._stopMotion();
    this._followSelected = false;
    if (this._selectedId) this._renderDetails();
    const bounds = this._parseBounds(this._lastEntity?.attributes?.bounds);
    if (bounds) {
      this._map.fitBounds(bounds, { padding: { top: 95, right: 45, bottom: 75, left: 45 }, pitch: finite(this._config.overview_pitch, 56), bearing: -18, duration: animated ? 1800 : 0, maxZoom: 11 });
      return;
    }
    const flights = this._filteredFlights();
    if (flights.length) {
      const box = new this._maplibre.LngLatBounds();
      flights.forEach((flight) => box.extend([flight.longitude, flight.latitude]));
      this._map.fitBounds(box, { padding: 70, pitch: finite(this._config.overview_pitch, 56), bearing: -18, duration: animated ? 1800 : 0, maxZoom: 11 });
    }
  }

  _parseBounds(raw) {
    const values = String(raw || "").split(",").map(Number);
    if (values.length !== 4 || !values.every(Number.isFinite)) return null;
    const [north, south, west, east] = values;
    return [[Math.min(west, east), Math.min(south, north)], [Math.max(west, east), Math.max(south, north)]];
  }

  _toggleStyle() {
    if (!this._map) return;
    this._stopMotion();
    this._mapReady = false;
    this._mapStyle = this._mapStyle === "satellite" ? "dark" : "satellite";
    this.shadowRoot.getElementById("style").textContent = this._mapStyle === "satellite" ? "SAT" : "DARK";
    this._map.setStyle(this._buildMapStyle(this._mapStyle));
    this._map.once("style.load", () => {
      this._installAircraftImages();
      this._installFlightLayers();
      this._mapReady = true;
      this._applyData();
    });
  }

  _toggleFullscreen() {
    const card = this.shadowRoot.querySelector("ha-card");
    if (!document.fullscreenElement) card.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  _updateSelectionFilter() {
    if (!this._map?.getLayer("selected-aircraft-ring")) return;
    this._map.setFilter("selected-aircraft-ring", ["==", ["get", "id"], this._selectedId || "__none__"]);
  }

  _setLayerVisibility(id, visible) {
    if (this._map?.getLayer(id)) this._map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }

  _setStatus(message, error = false, duration = 2600) {
    const status = this.shadowRoot.getElementById("status");
    if (!status) return;
    if (this._statusTimer) clearTimeout(this._statusTimer);
    status.textContent = message;
    status.classList.toggle("error", error);
    status.classList.add("show");
    if (duration > 0) this._statusTimer = setTimeout(() => status.classList.remove("show"), duration);
  }

  _distanceKm(lat1, lon1, lat2, lon2) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const aLat = radians(lat1);
    const bLat = radians(lat2);
    const deltaLat = radians(lat2 - lat1);
    const deltaLon = radians(lon2 - lon1);
    const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(aLat) * Math.cos(bLat) * Math.sin(deltaLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

class FlightOrbit3DCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  _render() {
    if (!this._config) return;
    this.innerHTML = `
      <style>
        .grid { display: grid; gap: 12px; padding: 8px 0; }
        label { display: grid; gap: 5px; font-size: 12px; }
        input, select { box-sizing: border-box; width: 100%; padding: 9px; border: 1px solid var(--divider-color); border-radius: 6px; background: var(--card-background-color); color: var(--primary-text-color); }
        .checks { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
        .checks label { display: flex; align-items: center; gap: 8px; }
        .checks input { width: auto; }
      </style>
      <div class="grid">
        <label>Entity<input data-key="entity" value="${escapeHtml(this._config.entity || "")}"></label>
        <label>Title<input data-key="title" value="${escapeHtml(this._config.title || "AIR TRAFFIC // LIVE")}"></label>
        <label>Height<input data-key="height" type="number" min="360" max="1600" value="${finite(this._config.height, 700)}"></label>
        <label>Map style<select data-key="map_style"><option value="satellite" ${this._config.map_style !== "dark" ? "selected" : ""}>Satellite</option><option value="dark" ${this._config.map_style === "dark" ? "selected" : ""}>Dark</option></select></label>
        <div class="checks">
          ${this._check("show_ground", "Show ground vehicles")}
          ${this._check("show_tracks", "Show trails", true)}
          ${this._check("show_labels", "Show labels", true)}
          ${this._check("actual_altitude", "Actual altitude", true)}
          ${this._check("terrain", "3D terrain", true)}
          ${this._check("auto_orbit", "Orbit on selection", true)}
        </div>
      </div>`;
    this.querySelectorAll("input, select").forEach((control) => {
      control.addEventListener("change", () => {
        const key = control.dataset.key;
        const config = { ...this._config };
        if (control.type === "checkbox") config[key] = control.checked;
        else if (control.type === "number") config[key] = Number(control.value);
        else config[key] = control.value;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
      });
    });
  }

  _check(key, label, defaultValue = false) {
    const checked = this._config[key] ?? defaultValue;
    return `<label><input data-key="${key}" type="checkbox" ${checked ? "checked" : ""}>${label}</label>`;
  }
}

if (!customElements.get("flight-orbit-3d-card")) customElements.define("flight-orbit-3d-card", FlightOrbit3DCard);
if (!customElements.get("flight-orbit-3d-card-editor")) customElements.define("flight-orbit-3d-card-editor", FlightOrbit3DCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "flight-orbit-3d-card",
  name: "Flight Orbit 3D Card",
  description: "A 3D live aircraft map for the Home Assistant FlightRadar24 integration.",
  preview: true,
});

console.info(`%c FLIGHT-ORBIT-3D-CARD %c v${CARD_VERSION} `, "color:#051019;background:#59dcff;font-weight:900;padding:3px 7px", "color:#59dcff;background:#06111c;padding:3px 7px");
