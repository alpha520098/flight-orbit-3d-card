/*
 * Flight Orbit 3D Card for Home Assistant
 * Version 1.0.4
 *
 * Data source: AlexandrErohin/home-assistant-flightradar24
 * Map renderer: MapLibre GL JS 5.6.0 (bundled single-file build)
 */

const CARD_VERSION = "1.0.4";
const MAPLIBRE_CSS_TEXT = "__MAPLIBRE_CSS__";
const MAP_BOOT_TIMEOUT_MS = 8000;
const EMPTY_COLLECTION = Object.freeze({ type: "FeatureCollection", features: [] });

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&")
  .replaceAll("<", "<")
  .replaceAll(">", ">")
  .replaceAll('"', """)
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
    this._terrainEnabled = false;
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
    this._terrainEnabled = false;

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
