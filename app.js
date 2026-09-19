import { GAME_STATIONS } from './stations.js';
import {
  classifyPoint,
  distanceToFeatureBoundaryMeters,
  featureName,
  geometryBounds,
  haversineMeters,
  nearestStation,
} from './geo.js';

const STATS_SOURCE_PAGE =
  'https://services2.arcgis.com/vKb0s8tBIA3bdocZ/ArcGIS/rest/services/Territorial_Authority_Local_Board_2026/FeatureServer/0';
const STATS_QUERY_URLS = [
  'https://services2.arcgis.com/vKb0s8tBIA3bdocZ/ArcGIS/rest/services/Territorial_Authority_Local_Board_2026/FeatureServer/0/query?' +
    new URLSearchParams({
      where: "TALB2026_V1_00 LIKE '076%'",
      outFields: 'TALB2026_V1_00,TALB2026_V1_00_NAME',
      returnGeometry: 'true',
      outSR: '4326',
      geometryPrecision: '5',
      maxAllowableOffset: '0.00005',
      f: 'geojson',
    }).toString(),
  'https://services2.arcgis.com/vKb0s8tBIA3bdocZ/ArcGIS/rest/services/Community_Board_2026/FeatureServer/0/query?' +
    new URLSearchParams({
      where: "CB2026_V1_00 LIKE '076%'",
      outFields: 'CB2026_V1_00,CB2026_V1_00_NAME',
      returnGeometry: 'true',
      outSR: '4326',
      geometryPrecision: '5',
      maxAllowableOffset: '0.00005',
      f: 'geojson',
    }).toString(),
];

const EXPECTED_BOARD_COUNT = 21;
const CACHE_DB = 'jetlag-auckland-local-board-finder';
const CACHE_STORE = 'boundaries';
const CACHE_KEY = 'stats-nz-talbs-2026-auckland';
const GAME_RULE_BOUNDARY_BUFFER_M = 25;

const state = {
  boards: [],
  selectedFeature: null,
  selectedPoint: null,
  selectedPointLabel: null,
  currentLocation: null,
  currentAccuracy: null,
  nearestGameStation: null,
  mapMode: 'game',
  source: null,
};

const $ = (id) => document.getElementById(id);
const elements = {
  gpsButton: $('gpsButton'),
  retryButton: $('retryButton'),
  locationStatus: $('locationStatus'),
  resultCard: $('resultCard'),
  resultEyebrow: $('resultEyebrow'),
  boardName: $('boardName'),
  resultDetail: $('resultDetail'),
  accuracyRow: $('accuracyRow'),
  accuracyValue: $('accuracyValue'),
  boundaryRow: $('boundaryRow'),
  boundaryValue: $('boundaryValue'),
  warningBox: $('warningBox'),
  warningText: $('warningText'),
  nearestStationRow: $('nearestStationRow'),
  nearestStationValue: $('nearestStationValue'),
  useNearestStationButton: $('useNearestStationButton'),
  copyButton: $('copyButton'),
  stationSearch: $('stationSearch'),
  stationList: $('stationList'),
  stationResults: $('stationResults'),
  mapSvg: $('mapSvg'),
  mapTitle: $('mapTitle'),
  mapHint: $('mapHint'),
  showGameButton: $('showGameButton'),
  focusButton: $('focusButton'),
  sourceStatus: $('sourceStatus'),
  sourceLink: $('sourceLink'),
  offlineBadge: $('offlineBadge'),
  installButton: $('installButton'),
};

let deferredInstallPrompt = null;

function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '—';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}

function status(message, kind = 'neutral') {
  elements.locationStatus.textContent = message;
  elements.locationStatus.dataset.kind = kind;
}

function updateOnlineBadge() {
  const online = navigator.onLine;
  elements.offlineBadge.textContent = online ? 'Online' : 'Offline';
  elements.offlineBadge.dataset.online = String(online);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveCachedBoundaries(data) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      tx.objectStore(CACHE_STORE).put(
        { data, savedAt: new Date().toISOString() },
        CACHE_KEY,
      );
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.warn('Could not cache Local Board boundaries', error);
  }
}

async function getCachedBoundaries() {
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readonly');
      const request = tx.objectStore(CACHE_STORE).get(CACHE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  } catch (error) {
    console.warn('Could not read cached Local Board boundaries', error);
    return null;
  }
}

function validateBoundaryData(data) {
  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('Boundary response was not valid GeoJSON.');
  }
  const polygonFeatures = data.features.filter((feature) => {
    const isPolygon = ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type);
    const props = feature?.properties || {};
    const code = String(props.TALB2026_V1_00 || props.CB2026_V1_00 || '');
    return isPolygon && code.startsWith('076');
  });
  if (polygonFeatures.length !== EXPECTED_BOARD_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_BOARD_COUNT} Auckland Local Boards, received ${polygonFeatures.length}.`,
    );
  }
  return polygonFeatures;
}

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-cache', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadBoundaries() {
  elements.sourceStatus.textContent = 'Loading official 2026 boundaries…';
  for (const url of STATS_QUERY_URLS) {
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) throw new Error(`Stats NZ service returned ${response.status}.`);
      const data = await response.json();
      state.boards = validateBoundaryData(data);
      state.source = 'live';
      elements.sourceStatus.textContent = `Official 2026 boundaries loaded (${state.boards.length} Local Boards).`;
      await saveCachedBoundaries({ type: 'FeatureCollection', features: state.boards });
      renderMap();
      return;
    } catch (networkError) {
      console.warn('Live boundary load failed', networkError);
    }
  }

  const cached = await getCachedBoundaries();
  if (cached?.data) {
    state.boards = validateBoundaryData(cached.data);
    state.source = 'cache';
    const date = cached.savedAt ? new Date(cached.savedAt).toLocaleDateString('en-NZ') : 'earlier';
    elements.sourceStatus.textContent = `Using boundaries cached on ${date}.`;
    renderMap();
    return;
  }

  state.source = 'error';
  elements.sourceStatus.textContent =
    'Could not load the Local Board boundaries. Connect to the internet and reload once; they will be cached for later use.';
  status('Boundary data is unavailable. Connect to the internet and reload.', 'error');
}

function boardResultForPoint(point) {
  if (!state.boards.length) return null;
  return classifyPoint(point, state.boards, 500);
}

function setResult(point, label, accuracy = null, sourceType = 'location') {
  const result = boardResultForPoint(point);
  state.selectedPoint = point;
  state.selectedPointLabel = label;
  state.currentAccuracy = accuracy;

  elements.resultCard.hidden = false;
  elements.warningBox.hidden = true;
  elements.nearestStationRow.hidden = true;
  elements.useNearestStationButton.hidden = true;
  elements.accuracyRow.hidden = accuracy == null;

  if (!result) {
    state.selectedFeature = null;
    elements.resultEyebrow.textContent = 'No board found';
    elements.boardName.textContent = 'Outside the game boundary data';
    elements.resultDetail.textContent =
      'This point is not inside, or close enough to, any Auckland Local Board polygon.';
    elements.boundaryRow.hidden = true;
    renderMap();
    return;
  }

  state.selectedFeature = result.feature;
  elements.resultEyebrow.textContent =
    result.mode === 'inside' ? 'Local Board' : 'Nearest Local Board';
  elements.boardName.textContent = result.name;
  elements.resultDetail.textContent =
    result.mode === 'inside'
      ? `${label} is inside this Local Board.`
      : `${label} falls just outside a land polygon, so the nearest Local Board is shown.`;
  elements.boundaryRow.hidden = false;
  elements.boundaryValue.textContent = formatDistance(result.boundaryDistance);

  if (accuracy != null) {
    elements.accuracyValue.textContent = `±${Math.round(accuracy)} m`;
    const threshold = Math.max(accuracy, GAME_RULE_BOUNDARY_BUFFER_M);
    if (result.boundaryDistance <= threshold || result.mode === 'nearest') {
      elements.warningBox.hidden = false;
      elements.warningText.textContent =
        result.mode === 'nearest'
          ? 'This location is just outside a land polygon. If you are at a game station, use the station coordinate as the tie-breaker.'
          : `Your GPS accuracy or the 25 m boundary buffer reaches the nearest Local Board boundary. For the game, use the station-coordinate tie-breaker if you are at a station.`;
    }
  } else if (result.mode === 'nearest') {
    elements.warningBox.hidden = false;
    elements.warningText.textContent =
      'This station coordinate is just offshore or outside the land polygon; the nearest Local Board is being used.';
  }

  if (sourceType === 'location') {
    const nearest = nearestStation(point, GAME_STATIONS);
    state.nearestGameStation = nearest;
    if (nearest) {
      elements.nearestStationRow.hidden = false;
      elements.nearestStationValue.textContent = `${nearest.station.name} (${formatDistance(nearest.distance)})`;
      elements.useNearestStationButton.hidden = nearest.distance > 500;
    }
  } else {
    state.nearestGameStation = null;
  }

  state.mapMode = 'focus';
  renderMap();
}

function requestLocation() {
  if (!state.boards.length) {
    status('Still loading official Local Board boundaries. Try again in a moment.', 'warning');
    return;
  }
  if (!navigator.geolocation) {
    status('This browser does not support location access. Use station search instead.', 'error');
    return;
  }

  elements.gpsButton.disabled = true;
  status('Getting a high-accuracy GPS fix…', 'loading');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const point = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      };
      state.currentLocation = point;
      const accuracy = position.coords.accuracy;
      status('Location found.', 'success');
      setResult(point, 'Your current location', accuracy, 'location');
      elements.gpsButton.disabled = false;
      elements.retryButton.hidden = false;
    },
    (error) => {
      const reasons = {
        1: 'Location permission was denied. Enable location permission or use station search.',
        2: 'Your phone could not determine its location. Try again outdoors or use station search.',
        3: 'Location lookup timed out. Try again or use station search.',
      };
      status(reasons[error.code] || 'Could not access your location.', 'error');
      elements.gpsButton.disabled = false;
      elements.retryButton.hidden = false;
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 },
  );
}

function useNearestStationTieBreaker() {
  const nearest = state.nearestGameStation;
  if (!nearest) return;
  setResult(
    { lat: nearest.station.lat, lon: nearest.station.lon },
    `${nearest.station.name} station coordinate`,
    null,
    'station',
  );
  status(`Using ${nearest.station.name} as the game tie-breaker.`, 'success');
}

function populateStationList() {
  elements.stationList.innerHTML = '';
  for (const station of GAME_STATIONS) {
    const option = document.createElement('option');
    option.value = station.name;
    elements.stationList.append(option);
  }
}

function findStationByName(value) {
  const normalized = value.trim().toLocaleLowerCase('en-NZ');
  return GAME_STATIONS.find(
    (station) => station.name.toLocaleLowerCase('en-NZ') === normalized,
  );
}

function showStationSearchResults(query) {
  const normalized = query.trim().toLocaleLowerCase('en-NZ');
  if (!normalized) {
    elements.stationResults.hidden = true;
    elements.stationResults.innerHTML = '';
    return;
  }
  const matches = GAME_STATIONS.filter((station) =>
    station.name.toLocaleLowerCase('en-NZ').includes(normalized),
  ).slice(0, 8);

  if (!matches.length) {
    elements.stationResults.innerHTML = '<div class="search-empty">No game station found.</div>';
    elements.stationResults.hidden = false;
    return;
  }

  elements.stationResults.innerHTML = '';
  for (const station of matches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'station-result';
    button.textContent = station.name;
    button.addEventListener('click', () => selectStation(station));
    elements.stationResults.append(button);
  }
  elements.stationResults.hidden = false;
}

function selectStation(station) {
  if (!state.boards.length) {
    status('Local Board boundaries are still loading.', 'warning');
    return;
  }
  elements.stationSearch.value = station.name;
  elements.stationResults.hidden = true;
  setResult(
    { lat: station.lat, lon: station.lon },
    station.name,
    null,
    'station',
  );
  status(`Showing ${station.name}.`, 'success');
}

function coordinatesFromGeometry(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function defaultGameBounds() {
  const lons = GAME_STATIONS.map((s) => s.lon);
  const lats = GAME_STATIONS.map((s) => s.lat);
  return {
    minLon: Math.min(...lons) - 0.035,
    maxLon: Math.max(...lons) + 0.035,
    minLat: Math.min(...lats) - 0.035,
    maxLat: Math.max(...lats) + 0.035,
  };
}

function paddedBounds(bounds, fraction = 0.12) {
  if (!bounds) return defaultGameBounds();
  const lonSpan = Math.max(0.01, bounds.maxLon - bounds.minLon);
  const latSpan = Math.max(0.01, bounds.maxLat - bounds.minLat);
  return {
    minLon: bounds.minLon - lonSpan * fraction,
    maxLon: bounds.maxLon + lonSpan * fraction,
    minLat: bounds.minLat - latSpan * fraction,
    maxLat: bounds.maxLat + latSpan * fraction,
  };
}

function projectionForBounds(bounds, width = 1000, height = 680) {
  const refLat = (bounds.minLat + bounds.maxLat) / 2;
  const lonScale = Math.cos((refLat * Math.PI) / 180);
  const minX = bounds.minLon * lonScale;
  const maxX = bounds.maxLon * lonScale;
  const minY = -bounds.maxLat;
  const maxY = -bounds.minLat;
  const spanX = Math.max(1e-9, maxX - minX);
  const spanY = Math.max(1e-9, maxY - minY);
  const scale = Math.min(width / spanX, height / spanY);
  const drawnWidth = spanX * scale;
  const drawnHeight = spanY * scale;
  const xOffset = (width - drawnWidth) / 2;
  const yOffset = (height - drawnHeight) / 2;
  return ([lon, lat]) => [
    xOffset + (lon * lonScale - minX) * scale,
    yOffset + (-lat - minY) * scale,
  ];
}

function ringPath(ring, project) {
  return ring
    .map((coordinate, index) => {
      const [x, y] = project(coordinate);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ') + ' Z';
}

function featurePath(feature, project) {
  return coordinatesFromGeometry(feature.geometry)
    .map((ring) => ringPath(ring, project))
    .join(' ');
}

function setSelectedBoard(feature, point = null, label = null) {
  state.selectedFeature = feature;
  if (point) {
    state.selectedPoint = point;
    state.selectedPointLabel = label;
  }
  state.mapMode = 'focus';
  elements.resultCard.hidden = false;
  elements.resultEyebrow.textContent = 'Local Board';
  elements.boardName.textContent = featureName(feature);
  elements.resultDetail.textContent = 'Selected from the boundary map.';
  elements.accuracyRow.hidden = true;
  elements.boundaryRow.hidden = true;
  elements.warningBox.hidden = true;
  elements.nearestStationRow.hidden = true;
  elements.useNearestStationButton.hidden = true;
  renderMap();
}

function renderMap() {
  if (!state.boards.length) {
    elements.mapSvg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" class="map-loading">Loading boundaries…</text>';
    return;
  }

  let bounds = defaultGameBounds();
  if (state.mapMode === 'focus' && state.selectedFeature) {
    bounds = paddedBounds(geometryBounds(state.selectedFeature), 0.15);
  }
  const project = projectionForBounds(bounds);
  elements.mapSvg.setAttribute('viewBox', '0 0 1000 680');
  elements.mapSvg.innerHTML = '';

  const boardLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  boardLayer.setAttribute('class', 'board-layer');
  for (const feature of state.boards) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', featurePath(feature, project));
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute(
      'class',
      feature === state.selectedFeature ? 'board selected' : 'board',
    );
    path.setAttribute('aria-label', featureName(feature));
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = featureName(feature);
    path.append(title);
    path.addEventListener('click', () => setSelectedBoard(feature));
    boardLayer.append(path);
  }
  elements.mapSvg.append(boardLayer);

  const stationsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  stationsLayer.setAttribute('class', 'stations-layer');
  for (const station of GAME_STATIONS) {
    if (
      station.lon < bounds.minLon ||
      station.lon > bounds.maxLon ||
      station.lat < bounds.minLat ||
      station.lat > bounds.maxLat
    ) {
      continue;
    }
    const [x, y] = project([station.lon, station.lat]);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x.toFixed(1));
    circle.setAttribute('cy', y.toFixed(1));
    circle.setAttribute('r', '4.2');
    circle.setAttribute('class', 'station-dot');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = station.name;
    circle.append(title);
    circle.addEventListener('click', () => selectStation(station));
    stationsLayer.append(circle);
  }
  elements.mapSvg.append(stationsLayer);

  if (state.selectedPoint) {
    const { lon, lat } = state.selectedPoint;
    if (lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat) {
      const [x, y] = project([lon, lat]);
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      marker.setAttribute('class', 'selected-marker');
      marker.innerHTML = `
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="16" class="marker-halo"></circle>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" class="marker-core"></circle>
      `;
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = state.selectedPointLabel || 'Selected location';
      marker.append(title);
      elements.mapSvg.append(marker);
    }
  }

  elements.mapTitle.textContent =
    state.mapMode === 'focus' && state.selectedFeature
      ? featureName(state.selectedFeature)
      : 'Auckland game area';
  elements.mapHint.textContent =
    state.mapMode === 'focus'
      ? 'Selected Local Board highlighted. Tap another boundary or station to inspect it.'
      : 'Tap a Local Board boundary or station dot to inspect it.';
  elements.focusButton.disabled = !state.selectedFeature;
}

async function copyResult() {
  if (!state.selectedFeature) return;
  const text = `${featureName(state.selectedFeature)} — ${state.selectedPointLabel || 'selected location'}`;
  try {
    await navigator.clipboard.writeText(text);
    status('Result copied to clipboard.', 'success');
  } catch {
    status(`Copy failed. Result: ${text}`, 'warning');
  }
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    elements.installButton.hidden = false;
  });
  elements.installButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    elements.installButton.hidden = true;
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Service worker registration failed', error);
    });
  }
}

function bindEvents() {
  elements.gpsButton.addEventListener('click', requestLocation);
  elements.retryButton.addEventListener('click', requestLocation);
  elements.useNearestStationButton.addEventListener('click', useNearestStationTieBreaker);
  elements.copyButton.addEventListener('click', copyResult);
  elements.showGameButton.addEventListener('click', () => {
    state.mapMode = 'game';
    renderMap();
  });
  elements.focusButton.addEventListener('click', () => {
    if (!state.selectedFeature) return;
    state.mapMode = 'focus';
    renderMap();
  });
  elements.stationSearch.addEventListener('input', (event) => {
    showStationSearchResults(event.target.value);
  });
  elements.stationSearch.addEventListener('change', (event) => {
    const station = findStationByName(event.target.value);
    if (station) selectStation(station);
  });
  document.addEventListener('click', (event) => {
    if (!elements.stationResults.contains(event.target) && event.target !== elements.stationSearch) {
      elements.stationResults.hidden = true;
    }
  });
  window.addEventListener('online', updateOnlineBadge);
  window.addEventListener('offline', updateOnlineBadge);
}

async function init() {
  elements.sourceLink.href = STATS_SOURCE_PAGE;
  populateStationList();
  bindEvents();
  updateOnlineBadge();
  setupInstallPrompt();
  registerServiceWorker();
  renderMap();
  await loadBoundaries();
}

init();
