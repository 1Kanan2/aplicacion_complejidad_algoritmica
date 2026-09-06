/*********************************************************
 *  ESTADO GLOBAL
 *********************************************************/
let graph = {};                // id -> [{ target, weight }]  (dirigido, sentido de referencia)
let reverseGraph = {};         // id -> [id...]                (u tal que u -> v existe, para alcanzabilidad inversa)
let undirectedAdj = {};        // id -> Set(id)                (no dirigido, para Conexas)
let uniqueEdges = [];          // [{ u, v, w }] una sola vez por par (para MST)
let nodes = {};                // id -> { id, name, region, level, type, lat, lon, relations, services }
let hospitalList = [];         // [{ id, name, region, level, type, search }] ordenado por nombre
let dataReady = false;

let map;
let markerById = {};           // id -> L.Marker
let routeLine = null;
let mstLine = null;
let ccLines = [];

let activeTabId = "dijkstra";

let selection = { origin: null, destination: null };
const reachableCache = { forward: new Map(), reverse: new Map() };

/*********************************************************
 *  UTILIDADES
 *********************************************************/
function normalizeText(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function formatKm(n, decimals = 2) {
  return Number(n).toLocaleString("es-PE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function debounce(fn, delay) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Nivel de complejidad IPRESS a partir del código de nivel (ej. "I-2", "II-1", "III-1").
 * IMPORTANTE: hay que comparar del prefijo más específico al menos específico,
 * porque "II-1" y "III-1" también empiezan con la letra "I".
 */
function levelCategory(level) {
  const lv = (level || "").toString().trim().toUpperCase();
  if (lv.startsWith("III")) return 3;
  if (lv.startsWith("II")) return 2;
  if (lv.startsWith("I")) return 1;
  return 0;
}

const LEVEL_META = {
  1: { cssVar: "--color-ipress-1", label: "Nivel I — Atención primaria", short: "Nivel I" },
  2: { cssVar: "--color-ipress-2", label: "Nivel II — Atención especializada", short: "Nivel II" },
  3: { cssVar: "--color-ipress-3", label: "Nivel III — Alta complejidad", short: "Nivel III" },
  0: { cssVar: "--color-text-secondary", label: "Nivel no especificado", short: "Sin nivel" }
};

/*********************************************************
 *  TOASTS
 *********************************************************/
let toastTimer = null;
function showToast(message, type = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = `toast toast-${type} is-visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), 3200);
}

/*********************************************************
 *  CARGA Y PARSEO DEL CSV
 *********************************************************/
function splitCSVLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      result.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  result.push(cur);
  return result;
}

function normalizeJsonField(field) {
  if (field == null) return "[]";
  let s = field.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  s = s.replace(/""/g, '"');
  return s;
}

async function loadCSV() {
  setMapLoading(true);
  let csvName = "peru_red_referencias_10reg.csv";
  let resp;
  try {
    resp = await fetch(csvName);
    if (!resp.ok) throw new Error("no encontrado");
  } catch (e) {
    try {
      csvName = "data.csv";
      resp = await fetch(csvName);
      if (!resp.ok) throw new Error("no encontrado fallback");
    } catch (e2) {
      console.error("No se pudo cargar el CSV:", e, e2);
      setMapError("No se encontró el archivo de datos de establecimientos. Verifica que 'peru_red_referencias_10reg.csv' esté junto a index.html.");
      return;
    }
  }

  let csvTextRaw;
  try {
    csvTextRaw = await resp.text();
  } catch (e) {
    setMapError("No se pudo leer el archivo de datos. Intenta recargar la página.");
    return;
  }

  const csvText = csvTextRaw.replace(/\r\n/g, "\n").trim();
  const rows = csvText.split("\n").filter((r) => r.trim().length > 0);

  graph = {};
  nodes = {};

  rows.forEach((row, idx) => {
    if (idx === 0 && /^id[,;]/i.test(row)) return;

    const parts = splitCSVLine(row);
    if (parts.length < 8) {
      console.warn("Fila con columnas inesperadas, se ignora:", idx + 1);
      return;
    }

    const [idRaw, nameRaw, regionRaw, levelRaw, typeRaw, latRaw, lonRaw, relationsRaw = "[]", servicesRaw = "[]"] = parts;

    const id = (idRaw || "").trim();
    if (!id) return;

    const name = (nameRaw || "").trim();
    const region = (regionRaw || "").trim();
    const level = (levelRaw || "").trim();
    const tipo = (typeRaw || "").trim();
    const lat = Number((latRaw || "").trim());
    const lon = Number((lonRaw || "").trim());

    let relations = [];
    try {
      relations = JSON.parse(normalizeJsonField(relationsRaw));
      if (!Array.isArray(relations)) relations = [];
    } catch (e) {
      relations = [];
    }

    let services = [];
    try {
      services = JSON.parse(normalizeJsonField(servicesRaw));
      if (!Array.isArray(services)) services = [];
    } catch (e) {
      services = [];
    }

    nodes[id] = {
      id,
      name,
      region,
      level,
      type: tipo,
      lat: isFinite(lat) ? lat : null,
      lon: isFinite(lon) ? lon : null,
      relations,
      services
    };

    if (!graph[id]) graph[id] = [];

    relations.forEach((rel) => {
      const target = String(rel.target_id || "").trim();
      const weight = Number(rel.weight_km);
      if (!target || !isFinite(weight)) return;

      graph[id].push({ target, weight });

      if (!graph[target]) graph[target] = [];
      if (!nodes[target]) {
        nodes[target] = { id: target, name: target, lat: null, lon: null, region: null, level: null, type: null, relations: [], services: [] };
      }
    });
  });

  buildDerivedStructures();
  buildHospitalList();
  drawNodesOnMap();
  refreshSelectOptions("origin");
  refreshSelectOptions("destination");
  dataReady = true;
  setMapLoading(false);
  setActionsEnabled(true);
}

/**
 * Estructuras derivadas del grafo dirigido:
 *  - reverseGraph: adyacencia inversa (para alcanzabilidad hacia un destino)
 *  - undirectedAdj: adyacencia no dirigida (para Componentes Conexos)
 *  - uniqueEdges: una arista por par no ordenado, con el peso (para MST)
 * Se calculan una sola vez porque el grafo no cambia durante la sesión.
 */
function buildDerivedStructures() {
  undirectedAdj = {};
  reverseGraph = {};
  const uniq = new Map();

  Object.keys(nodes).forEach((n) => (undirectedAdj[n] = new Set()));

  Object.keys(graph).forEach((u) => {
    if (!undirectedAdj[u]) undirectedAdj[u] = new Set();
    (graph[u] || []).forEach((edge) => {
      const v = edge.target;
      if (!undirectedAdj[v]) undirectedAdj[v] = new Set();
      undirectedAdj[u].add(v);
      undirectedAdj[v].add(u);

      if (!reverseGraph[v]) reverseGraph[v] = [];
      reverseGraph[v].push(u);

      const key = u < v ? `${u}|${v}` : `${v}|${u}`;
      if (!uniq.has(key)) uniq.set(key, { u, v, w: edge.weight });
    });
  });

  uniqueEdges = Array.from(uniq.values());
}

function buildHospitalList() {
  hospitalList = Object.values(nodes)
    .filter((n) => n.lat != null && n.lon != null)
    .map((n) => ({
      id: n.id,
      name: n.name || n.id,
      region: n.region || "",
      level: n.level || "",
      type: n.type || "",
      search: normalizeText(`${n.name} ${n.id} ${n.region} ${n.type} ${n.level}`)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

/*********************************************************
 *  ALCANZABILIDAD DIRIGIDA (para guiar la selección de Dijkstra)
 *  El grafo es dirigido (las referencias van de menor a mayor
 *  complejidad), así que cada establecimiento solo puede llegar
 *  a un puñado de otros (en promedio ~11 de 1723). Sin esta
 *  guía, elegir un par de establecimientos al azar tiene ~99%
 *  de probabilidad de no tener ninguna ruta posible.
 *********************************************************/
function computeForwardReachable(startId) {
  if (reachableCache.forward.has(startId)) return reachableCache.forward.get(startId);
  const visited = new Set([startId]);
  const stack = [startId];
  while (stack.length) {
    const u = stack.pop();
    (graph[u] || []).forEach((e) => {
      if (!visited.has(e.target)) {
        visited.add(e.target);
        stack.push(e.target);
      }
    });
  }
  visited.delete(startId);
  reachableCache.forward.set(startId, visited);
  return visited;
}

function computeReverseReachable(targetId) {
  if (reachableCache.reverse.has(targetId)) return reachableCache.reverse.get(targetId);
  const visited = new Set([targetId]);
  const stack = [targetId];
  while (stack.length) {
    const u = stack.pop();
    (reverseGraph[u] || []).forEach((p) => {
      if (!visited.has(p)) {
        visited.add(p);
        stack.push(p);
      }
    });
  }
  visited.delete(targetId);
  reachableCache.reverse.set(targetId, visited);
  return visited;
}

/** Conjunto de ids válidos para `role`, dado lo que ya esté elegido en el otro campo. null = sin restricción. */
function getReachabilityConstraint(role) {
  if (role === "destination" && selection.origin) {
    return computeForwardReachable(selection.origin);
  }
  if (role === "origin" && selection.destination) {
    return computeReverseReachable(selection.destination);
  }
  return null;
}

/*********************************************************
 *  MAPA — INICIALIZACIÓN, MARCADORES, LEYENDA
 *********************************************************/
function initMap() {
  map = L.map("map", { zoomControl: true, minZoom: 4 }).setView([-9.19, -75.02], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
}

function buildMarkerIcon(category, state) {
  const size = state ? 34 : 22;
  const glyphs = {
    1: `<svg viewBox="0 0 24 24" width="${size * 0.5}" height="${size * 0.5}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    2: `<svg viewBox="0 0 24 24" width="${size * 0.56}" height="${size * 0.56}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21h16M6 21V8l6-4 6 4v13"/><path d="M12 10v5M9.5 12.5h5"/></svg>`,
    3: `<svg viewBox="0 0 24 24" width="${size * 0.58}" height="${size * 0.58}" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V10l7-6 7 6v11"/><path d="M12 12v6M9 15h6"/></svg>`,
    0: `<svg viewBox="0 0 24 24" width="${size * 0.4}" height="${size * 0.4}" fill="#fff"><circle cx="12" cy="12" r="4"/></svg>`
  };
  const html = `<span class="map-marker marker-level-${category}${state ? " is-" + state : ""}">${glyphs[category] || glyphs[0]}</span>`;
  return L.divIcon({
    html,
    className: "map-marker-wrapper",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2 - 2]
  });
}

function drawNodesOnMap() {
  Object.values(markerById).forEach((m) => {
    try { map.removeLayer(m); } catch (e) {}
  });
  markerById = {};

  Object.values(nodes).forEach((n) => {
    if (n.lat == null || n.lon == null || Number.isNaN(n.lat) || Number.isNaN(n.lon)) return;

    const category = levelCategory(n.level);
    const marker = L.marker([n.lat, n.lon], { icon: buildMarkerIcon(category, null) }).addTo(map);

    marker.bindTooltip(
      `<strong>${escapeHtml(n.name)}</strong><br>${escapeHtml(n.id)} · ${escapeHtml(n.region || "—")}<br>${escapeHtml((LEVEL_META[category] || LEVEL_META[0]).short)}`,
      { direction: "top", sticky: true, opacity: 0.96, className: "leaflet-tooltip-custom" }
    );

    marker.bindPopup(buildPopupHtml(n, category));

    marker.on("click", () => handleMarkerClick(n.id));

    markerById[n.id] = marker;
  });
}

function buildPopupHtml(n, category) {
  const meta = LEVEL_META[category] || LEVEL_META[0];
  return `
    <div class="popup-card">
      <strong>${escapeHtml(n.name)}</strong>
      <span class="popup-code">${escapeHtml(n.id)}</span>
      <div class="popup-row"><span class="popup-dot marker-level-${category}"></span>${escapeHtml(meta.short)}</div>
      <div class="popup-row">${escapeHtml(n.region || "Región no especificada")}</div>
      <div class="popup-row popup-hint">Haz clic para usarlo como origen o destino en "Ruta más corta".</div>
    </div>`;
}

function handleMarkerClick(id) {
  if (activeTabId !== "dijkstra") return;

  if (!selection.origin) {
    selectHospital("origin", id);
    showToast(`${nodes[id].name} seleccionado como origen`, "success");
    return;
  }
  if (!selection.destination) {
    if (id === selection.origin) {
      showToast("Ese establecimiento ya es el origen. Elige otro para el destino.", "warning");
      return;
    }
    const reachable = computeForwardReachable(selection.origin);
    if (!reachable.has(id)) {
      showToast("Ese establecimiento no tiene una ruta de referencia directa desde el origen elegido. Prueba con otro de la lista de destinos disponibles.", "warning");
      return;
    }
    selectHospital("destination", id);
    showToast(`${nodes[id].name} seleccionado como destino`, "success");
    return;
  }
  clearSelection("destination");
  selectHospital("origin", id);
  showToast(`${nodes[id].name} seleccionado como nuevo origen`, "success");
}

function setMarkerVisualState(id, state) {
  const marker = markerById[id];
  if (!marker) return;
  const category = levelCategory(nodes[id].level);
  marker.setIcon(buildMarkerIcon(category, state));
  if (marker.getElement()) {
    marker.getElement().style.zIndex = state ? 10000 : "";
  }
}

/*********************************************************
 *  ESTADOS DE CARGA DEL MAPA
 *********************************************************/
function setMapLoading(isLoading) {
  const el = document.getElementById("map-loading");
  const errEl = document.getElementById("map-error");
  if (errEl) errEl.hidden = true;
  if (!el) return;
  el.hidden = !isLoading;
}

function setMapError(message) {
  const loadingEl = document.getElementById("map-loading");
  if (loadingEl) loadingEl.hidden = true;
  const errEl = document.getElementById("map-error");
  if (!errEl) return;
  errEl.hidden = false;
  const msgEl = errEl.querySelector(".map-error-message");
  if (msgEl) msgEl.textContent = message;
}

function setActionsEnabled(enabled) {
  ["btn-calc-dijkstra", "btn-run-mst", "btn-run-cc"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
}

/*********************************************************
 *  SELECCIÓN DE HOSPITALES (input + select + mapa sincronizados)
 *********************************************************/
function selectHospital(role, id) {
  const node = nodes[id];
  if (!node) return;

  const prevId = selection[role];
  if (prevId && prevId !== id) setMarkerVisualState(prevId, null);

  selection[role] = id;
  setMarkerVisualState(id, role);

  syncComboUI(role, node);
  updateChip(role, node);
  updateMapFocus();
  updateDijkstraButtonState();

  const otherRole = role === "origin" ? "destination" : "origin";
  reconcileOppositeSelection(role, otherRole);
  refreshSelectOptions(otherRole);
  updateReachabilityNote(otherRole);
}

/**
 * Si al fijar `changedRole` el valor ya elegido en `otherRole` deja de ser
 * válido, se invalida con aviso. Un mismo establecimiento elegido en ambos
 * campos NO pasa por aquí: un nodo siempre queda fuera de su propio conjunto
 * de alcanzabilidad, así que sin este resguardo se invalidaría el otro campo
 * en silencio en vez de dejar que el aviso explícito de "mismo origen y
 * destino" (en runDijkstra) se lo explique al usuario con claridad.
 */
function reconcileOppositeSelection(changedRole, otherRole) {
  const otherId = selection[otherRole];
  if (!otherId || otherId === selection[changedRole]) return;
  const constraint = getReachabilityConstraint(otherRole);
  if (constraint && !constraint.has(otherId)) {
    invalidateSelection(otherRole);
    showToast(
      otherRole === "destination"
        ? "El destino elegido ya no es alcanzable desde el nuevo origen. Elige uno nuevo de la lista."
        : "El origen elegido ya no puede llegar al destino actual. Elige uno nuevo de la lista.",
      "warning"
    );
  }
}

function clearSelection(role) {
  const prevId = selection[role];
  if (prevId) setMarkerVisualState(prevId, null);
  selection[role] = null;

  const field = document.querySelector(`.combo-field[data-field="${role}"]`);
  if (field) {
    field.querySelector(".combo-input").value = "";
    field.querySelector(".combo-select").value = "";
    const chip = field.querySelector(".selected-chip");
    if (chip) chip.hidden = true;
    hideSuggestions(role);
  }
  updateDijkstraButtonState();

  const otherRole = role === "origin" ? "destination" : "origin";
  refreshSelectOptions(otherRole);
  updateReachabilityNote(otherRole);
}

/**
 * Igual que clearSelection pero sin tocar lo que el usuario está escribiendo
 * en el input (se usa cuando el texto tecleado deja de coincidir con la
 * selección vigente, para no sobrescribir lo que la persona está tipeando).
 */
function invalidateSelection(role) {
  const prevId = selection[role];
  if (!prevId) return;
  setMarkerVisualState(prevId, null);
  selection[role] = null;

  const field = document.querySelector(`.combo-field[data-field="${role}"]`);
  if (field) {
    field.querySelector(".combo-select").value = "";
    const chip = field.querySelector(".selected-chip");
    if (chip) chip.hidden = true;
  }
  updateDijkstraButtonState();

  const otherRole = role === "origin" ? "destination" : "origin";
  refreshSelectOptions(otherRole);
  updateReachabilityNote(otherRole);
}

function syncComboUI(role, node) {
  const field = document.querySelector(`.combo-field[data-field="${role}"]`);
  if (!field) return;
  field.querySelector(".combo-input").value = node.name;
  field.querySelector(".combo-select").value = node.id;
  hideSuggestions(role);
}

function updateChip(role, node) {
  const field = document.querySelector(`.combo-field[data-field="${role}"]`);
  if (!field) return;
  const chip = field.querySelector(".selected-chip");
  if (!chip) return;
  const category = levelCategory(node.level);
  chip.hidden = false;
  chip.querySelector(".chip-dot").className = `chip-dot marker-level-${category}`;
  chip.querySelector(".chip-name").textContent = node.name;
  chip.querySelector(".chip-meta").textContent = `${node.id} · ${node.region || "Región no especificada"} · ${(LEVEL_META[category] || LEVEL_META[0]).short}`;
}

/** Muestra cuántas opciones válidas quedan del lado opuesto, para que la restricción no se sienta como un misterio. */
function updateReachabilityNote(role) {
  const field = document.querySelector(`.combo-field[data-field="${role}"]`);
  if (!field) return;
  const noteEl = field.querySelector(".field-note");
  if (!noteEl) return;

  const constraint = getReachabilityConstraint(role);
  if (!constraint) {
    noteEl.hidden = true;
    return;
  }

  noteEl.hidden = false;
  if (constraint.size === 0) {
    noteEl.textContent =
      role === "destination"
        ? "Este establecimiento no tiene referencias registradas hacia otro nivel: no se puede usar como origen."
        : "Ningún establecimiento tiene registrada una referencia directa hacia este destino.";
    noteEl.classList.add("field-note-warning");
  } else {
    noteEl.textContent =
      role === "destination"
        ? `${constraint.size} destino${constraint.size === 1 ? "" : "s"} alcanzable${constraint.size === 1 ? "" : "s"} desde el origen elegido.`
        : `${constraint.size} establecimiento${constraint.size === 1 ? "" : "s"} pueden llegar a este destino.`;
    noteEl.classList.remove("field-note-warning");
  }
}

function updateMapFocus() {
  const pts = [];
  if (selection.origin && nodes[selection.origin]) {
    const n = nodes[selection.origin];
    if (n.lat != null) pts.push([n.lat, n.lon]);
  }
  if (selection.destination && nodes[selection.destination]) {
    const n = nodes[selection.destination];
    if (n.lat != null) pts.push([n.lat, n.lon]);
  }
  if (pts.length === 1) {
    map.flyTo(pts[0], Math.max(map.getZoom(), 9), { duration: 0.6 });
  } else if (pts.length === 2) {
    map.flyToBounds(L.latLngBounds(pts), { padding: [80, 80], duration: 0.6 });
  }
}

function updateDijkstraButtonState() {
  const btn = document.getElementById("btn-calc-dijkstra");
  if (btn) btn.disabled = !dataReady || !selection.origin || !selection.destination;
}

/** Reconstruye las <option> de un <select> respetando la restricción de alcanzabilidad vigente. */
function refreshSelectOptions(role) {
  const field = document.querySelector(`.combo-field[data-field="${role}"]`);
  if (!field) return;
  const select = field.querySelector(".combo-select");
  const currentValue = selection[role] || select.value;
  const constraint = getReachabilityConstraint(role);
  const list = constraint ? hospitalList.filter((h) => constraint.has(h.id)) : hospitalList;

  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = constraint ? `Elegir entre los ${list.length} disponibles…` : "Elegir de la lista completa…";
  select.appendChild(placeholder);

  list.forEach((h) => {
    const opt = document.createElement("option");
    opt.value = h.id;
    opt.textContent = `${h.name} — ${h.id} (${h.region})`;
    select.appendChild(opt);
  });

  select.value = currentValue && list.some((h) => h.id === currentValue) ? currentValue : "";
}

/** Candidatos válidos para un campo dado un texto de búsqueda: aplica alcanzabilidad + coincidencia de texto. */
function getFilteredCandidates(role, query, limit) {
  const constraint = getReachabilityConstraint(role);
  const base = constraint ? hospitalList.filter((h) => constraint.has(h.id)) : hospitalList;
  const q = normalizeText(query);
  const matches = q ? base.filter((h) => h.search.includes(q)) : base;
  return typeof limit === "number" ? matches.slice(0, limit) : matches;
}

function renderSuggestions(role, query) {
  const field = document.querySelector(`.combo-field[data-field="${role}"]`);
  if (!field) return;
  const listEl = field.querySelector(".combo-suggestions");
  const inputEl = field.querySelector(".combo-input");
  const q = normalizeText(query);

  if (!q) {
    listEl.hidden = true;
    listEl.innerHTML = "";
    inputEl.setAttribute("aria-expanded", "false");
    return;
  }
  inputEl.setAttribute("aria-expanded", "true");

  const matches = getFilteredCandidates(role, query, 8);

  if (matches.length === 0) {
    const constrained = !!getReachabilityConstraint(role);
    listEl.innerHTML = `<li class="combo-empty">${
      constrained
        ? `Ningún destino alcanzable coincide con "${escapeHtml(query)}".`
        : `Sin resultados para "${escapeHtml(query)}"`
    }</li>`;
    listEl.hidden = false;
    return;
  }

  listEl.innerHTML = matches
    .map(
      (h) => `
      <li class="combo-suggestion" data-id="${escapeHtml(h.id)}" role="option">
        <span class="suggestion-dot marker-level-${levelCategory(h.level)}"></span>
        <span class="suggestion-text">
          <strong>${escapeHtml(h.name)}</strong>
          <small>${escapeHtml(h.id)} · ${escapeHtml(h.region)}</small>
        </span>
      </li>`
    )
    .join("");
  listEl.hidden = false;
}

function hideSuggestions(role) {
  const field = document.querySelector(`.combo-field[data-field="${role}"]`);
  if (!field) return;
  const listEl = field.querySelector(".combo-suggestions");
  listEl.hidden = true;
  listEl.innerHTML = "";
  field.querySelector(".combo-input").setAttribute("aria-expanded", "false");
}

function initComboFields() {
  document.querySelectorAll(".combo-field").forEach((field) => {
    const role = field.getAttribute("data-field");
    const input = field.querySelector(".combo-input");
    const select = field.querySelector(".combo-select");
    const listEl = field.querySelector(".combo-suggestions");
    const clearBtn = field.querySelector(".combo-clear-btn");

    const debouncedRender = debounce((val) => renderSuggestions(role, val), 120);

    input.addEventListener("input", () => {
      clearBtn.hidden = input.value.length === 0;

      // Si lo que se está escribiendo ya no coincide con la selección vigente,
      // esa selección queda obsoleta: invalidarla evita calcular con un par
      // de establecimientos que ya no es el que se ve en pantalla.
      const currentId = selection[role];
      if (currentId && normalizeText(input.value) !== normalizeText(nodes[currentId].name)) {
        invalidateSelection(role);
      }

      debouncedRender(input.value);
    });

    input.addEventListener("focus", () => {
      if (input.value) renderSuggestions(role, input.value);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideSuggestions(role);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const q = normalizeText(input.value);
        if (!q) return;
        const matches = getFilteredCandidates(role, input.value);
        if (!matches.length) return;
        const exact = matches.find((h) => normalizeText(h.name) === q || normalizeText(h.id) === q);
        selectHospital(role, (exact || matches[0]).id);
      }
    });

    listEl.addEventListener("mousedown", (e) => {
      const li = e.target.closest(".combo-suggestion");
      if (!li) return;
      e.preventDefault();
      selectHospital(role, li.getAttribute("data-id"));
    });

    document.addEventListener("click", (e) => {
      if (!field.contains(e.target)) hideSuggestions(role);
    });

    select.addEventListener("change", () => {
      if (select.value) selectHospital(role, select.value);
    });

    clearBtn.addEventListener("click", () => clearSelection(role));
  });

  const swapBtn = document.getElementById("btn-swap");
  if (swapBtn) {
    swapBtn.addEventListener("click", () => {
      const { origin, destination } = selection;
      if (!origin && !destination) return;
      clearSelection("origin");
      clearSelection("destination");
      if (destination) selectHospital("origin", destination);
      if (origin) selectHospital("destination", origin);
    });
  }

  const clearAllBtn = document.getElementById("btn-clear-selection");
  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", () => {
      clearSelection("origin");
      clearSelection("destination");
      clearAllLines();
      setResultState("dijkstra", "empty");
    });
  }
}

/*********************************************************
 *  LIMPIEZA DE LÍNEAS DEL MAPA
 *********************************************************/
function clearAllLines() {
  try { if (routeLine) map.removeLayer(routeLine); } catch (e) {}
  routeLine = null;

  try { if (mstLine) map.removeLayer(mstLine); } catch (e) {}
  mstLine = null;

  ccLines.forEach((l) => { try { map.removeLayer(l); } catch (e) {} });
  ccLines = [];
}

/**
 * Anima el trazo de una polyline (efecto "dibujado" progresivo) manipulando
 * directamente el <path> SVG que genera Leaflet (stroke-dasharray/offset).
 */
function animatePolylineDraw(polyline, durationMs = 900, delayMs = 0) {
  if (!polyline) return;
  requestAnimationFrame(() => {
    const path = polyline._path;
    if (!path || typeof path.getTotalLength !== "function") return;
    let length;
    try { length = path.getTotalLength(); } catch (e) { return; }
    path.style.transition = "none";
    path.style.strokeDasharray = `${length}`;
    path.style.strokeDashoffset = `${length}`;
    path.getBoundingClientRect();
    setTimeout(() => {
      path.style.transition = `stroke-dashoffset ${durationMs}ms ease-out`;
      requestAnimationFrame(() => { path.style.strokeDashoffset = "0"; });
    }, delayMs);
  });
}

/** Anima un contador numérico de 0 (o su valor actual) hasta `to`. */
function animateNumber(el, to, durationMs = 700, decimals = 2) {
  if (!el) return;
  const from = 0;
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = from + (to - from) * eased;
    el.textContent = decimals > 0 ? formatKm(value, decimals) : Math.round(value).toLocaleString("es-PE");
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/*********************************************************
 *  RESULT PANELS — manejo de estados (empty/loading/error/success)
 *********************************************************/
function setResultState(tab, state, message) {
  const panel = document.getElementById(`result-${tab}`);
  if (!panel) return;
  panel.dataset.state = state;
  if (state === "error" && message) {
    const msgEl = panel.querySelector(".error-message");
    if (msgEl) msgEl.textContent = message;
  }
}

function runWithLoading(tab, work) {
  setResultState(tab, "loading");
  clearAllLines();
  setTimeout(work, 260);
}

/*********************************************************
 *  DIJKSTRA — cola de prioridad binaria (min-heap)
 *********************************************************/
class MinHeap {
  constructor() { this.data = []; }
  size() { return this.data.length; }
  push(item) {
    this.data.push(item);
    let i = this.data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[p].dist <= this.data[i].dist) break;
      [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
      i = p;
    }
  }
  pop() {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length) {
      this.data[0] = last;
      let i = 0;
      const n = this.data.length;
      while (true) {
        let l = 2 * i + 1, r = 2 * i + 2, smallest = i;
        if (l < n && this.data[l].dist < this.data[smallest].dist) smallest = l;
        if (r < n && this.data[r].dist < this.data[smallest].dist) smallest = r;
        if (smallest === i) break;
        [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Dijkstra con heap binario: O((V+E) log V) en lugar del O(V^2) original. */
function dijkstra(start) {
  const dist = {};
  const prev = {};
  Object.keys(graph).forEach((n) => {
    dist[n] = Infinity;
    prev[n] = null;
  });
  if (!(start in dist)) return { dist, prev };

  dist[start] = 0;
  const heap = new MinHeap();
  heap.push({ id: start, dist: 0 });
  const visited = new Set();

  while (heap.size()) {
    const { id: u, dist: d } = heap.pop();
    if (visited.has(u)) continue;
    visited.add(u);
    if (d > dist[u]) continue;

    (graph[u] || []).forEach((edge) => {
      const v = edge.target;
      const w = Number(edge.weight) || 0;
      if (!(v in dist)) { dist[v] = Infinity; prev[v] = null; }
      const alt = dist[u] + w;
      if (alt < dist[v]) {
        dist[v] = alt;
        prev[v] = u;
        heap.push({ id: v, dist: alt });
      }
    });
  }

  return { dist, prev };
}

function getPath(prev, start, end) {
  if (start === end) return [start];
  if (!(end in prev)) return [];
  const path = [];
  let u = end;
  const guard = new Set();
  while (u != null) {
    if (guard.has(u)) return [];
    guard.add(u);
    path.unshift(u);
    if (u === start) break;
    u = prev[u];
  }
  return path[0] === start ? path : [];
}

function runDijkstra() {
  if (!dataReady) return;
  const origen = selection.origin;
  const destino = selection.destination;

  if (!origen || !destino) {
    setResultState("dijkstra", "error", "Selecciona un establecimiento de origen y uno de destino antes de calcular.");
    return;
  }
  if (origen === destino) {
    setResultState("dijkstra", "error", "El origen y el destino no pueden ser el mismo establecimiento.");
    return;
  }

  runWithLoading("dijkstra", () => {
    const { dist, prev } = dijkstra(origen);
    const path = getPath(prev, origen, destino);

    if (!path.length || !isFinite(dist[destino])) {
      setResultState(
        "dijkstra",
        "error",
        "No existe una ruta de referencia entre estos establecimientos. Recuerda que las referencias del SRC siguen un sentido: de menor a mayor nivel de complejidad. Elige el destino de la lista sugerida: solo muestra opciones realmente alcanzables desde el origen."
      );
      return;
    }

    renderDijkstraResult(path, dist[destino]);
    drawRouteOnMap(path);
    setResultState("dijkstra", "success");
  });
}

function renderDijkstraResult(path, totalDistance) {
  const originNode = nodes[path[0]];
  const destNode = nodes[path[path.length - 1]];
  const panel = document.getElementById("result-dijkstra");

  panel.querySelector(".endpoint-origin").textContent = originNode.name;
  panel.querySelector(".endpoint-destination").textContent = destNode.name;

  const distanceEl = document.getElementById("dijkstra-distance-value");
  animateNumber(distanceEl, totalDistance, 800, 2);

  const hopsEl = document.getElementById("dijkstra-hops-count");
  hopsEl.textContent = path.length === 2 ? "Referencia directa" : `${path.length - 1} tramos intermedios`;

  const stepsEl = document.getElementById("dijkstra-steps");
  const stepsHtml = [];
  for (let i = 0; i < path.length - 1; i++) {
    const u = path[i], v = path[i + 1];
    const edge = (graph[u] || []).find((e) => e.target === v);
    const w = edge ? edge.weight : 0;
    stepsHtml.push(`
      <li class="route-step">
        <span class="step-index">${i + 1}</span>
        <span class="step-nodes">
          <strong>${escapeHtml(nodes[u].name)}</strong>
          <svg class="step-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          <strong>${escapeHtml(nodes[v].name)}</strong>
        </span>
        <span class="step-dist">${formatKm(w)} km</span>
      </li>`);
  }
  stepsEl.innerHTML = stepsHtml.join("");
}

function drawRouteOnMap(path) {
  clearAllLines();
  const latlngs = path.map((id) => nodes[id]).filter((n) => n && n.lat != null).map((n) => [n.lat, n.lon]);
  if (latlngs.length < 2) return;

  routeLine = L.polyline(latlngs, { color: "#E8622C", weight: 5, opacity: 0.95, lineCap: "round" }).addTo(map);
  animatePolylineDraw(routeLine, 900);
  map.flyToBounds(routeLine.getBounds(), { padding: [60, 60], duration: 0.7 });
}

/*********************************************************
 *  MST — KRUSKAL con Union-Find (path compression + union by size)
 *********************************************************/
function runMST() {
  if (!dataReady) return;
  runWithLoading("mst", () => {
    const edges = uniqueEdges.slice().sort((a, b) => a.w - b.w);

    const parent = {};
    const size = {};
    Object.keys(nodes).forEach((n) => { parent[n] = n; size[n] = 1; });

    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }
    function union(a, b) {
      let ra = find(a), rb = find(b);
      if (ra === rb) return false;
      if (size[ra] < size[rb]) [ra, rb] = [rb, ra];
      parent[rb] = ra;
      size[ra] += size[rb];
      return true;
    }

    const mst = [];
    let totalWeight = 0;
    edges.forEach((e) => {
      if (union(e.u, e.v)) {
        mst.push(e);
        totalWeight += e.w;
      }
    });

    const roots = new Set(Object.keys(nodes).map((n) => find(n)));

    renderMSTResult(mst, totalWeight, roots.size);
    drawMST(mst);
    setResultState("mst", "success");
  });
}

function renderMSTResult(mst, totalWeight, componentCount) {
  document.getElementById("mst-edge-count").textContent = mst.length.toLocaleString("es-PE");
  document.getElementById("mst-node-count").textContent = Object.keys(nodes).length.toLocaleString("es-PE");
  animateNumber(document.getElementById("mst-total-distance"), totalWeight, 900, 1);

  const noteEl = document.getElementById("mst-note");
  noteEl.textContent =
    componentCount > 1
      ? `La red no está completamente conectada: se generaron ${componentCount} árboles independientes (un bosque de expansión mínima).`
      : "La red está completamente conectada: un único árbol conecta todos los establecimientos con la menor distancia total posible.";

  window.__mstEdges = mst;
  renderEdgeList(mst);

  const filterInput = document.getElementById("mst-filter");
  if (filterInput && !filterInput.dataset.bound) {
    filterInput.dataset.bound = "1";
    filterInput.addEventListener("input", debounce(() => {
      const q = normalizeText(filterInput.value);
      const filtered = !q
        ? window.__mstEdges
        : window.__mstEdges.filter((e) => normalizeText(`${nodes[e.u].name} ${e.u} ${nodes[e.v].name} ${e.v}`).includes(q));
      renderEdgeList(filtered);
    }, 150));
  }
}

function renderEdgeList(edges) {
  const listEl = document.getElementById("mst-edge-list");
  if (!edges.length) {
    listEl.innerHTML = `<li class="combo-empty">Sin resultados para el filtro aplicado.</li>`;
    return;
  }
  listEl.innerHTML = edges
    .map(
      (e) => `
      <li class="edge-row">
        <span class="edge-nodes">${escapeHtml(nodes[e.u].name)} <span class="edge-sep">↔</span> ${escapeHtml(nodes[e.v].name)}</span>
        <span class="edge-weight">${formatKm(e.w)} km</span>
      </li>`
    )
    .join("");
}

function drawMST(mst) {
  clearAllLines();
  const segments = mst
    .map((e) => {
      const nu = nodes[e.u], nv = nodes[e.v];
      if (!nu || !nv || nu.lat == null || nv.lat == null) return null;
      return [[nu.lat, nu.lon], [nv.lat, nv.lon]];
    })
    .filter(Boolean);

  if (!segments.length) return;

  mstLine = L.polyline(segments, { color: "#1D6FA5", weight: 2.4, opacity: 0.85 }).addTo(map);
  animatePolylineDraw(mstLine, 1400);
  map.flyToBounds(mstLine.getBounds(), { padding: [40, 40], duration: 0.7 });
}

/*********************************************************
 *  COMPONENTES CONEXOS (conectividad no dirigida / débil)
 *  Se ignora el sentido de la referencia: dos establecimientos
 *  están en el mismo componente si existe un camino entre ellos
 *  en cualquier dirección. Esto responde la pregunta relevante
 *  para el SRC: "¿qué establecimientos quedan aislados de la red?"
 *********************************************************/
function runConnectedComponents() {
  if (!dataReady) return;
  runWithLoading("cc", () => {
    const visited = new Set();
    const result = [];

    Object.keys(nodes).forEach((start) => {
      if (visited.has(start)) return;
      const comp = [];
      const stack = [start];
      visited.add(start);
      while (stack.length) {
        const u = stack.pop();
        comp.push(u);
        (undirectedAdj[u] || new Set()).forEach((v) => {
          if (!visited.has(v)) {
            visited.add(v);
            stack.push(v);
          }
        });
      }
      result.push(comp);
    });

    result.sort((a, b) => b.length - a.length);

    renderCCResult(result);
    drawConnectedComponents(result);
    setResultState("cc", "success");
  });
}

function renderCCResult(components) {
  const noteEl = document.getElementById("cc-note");
  const total = Object.keys(nodes).length;
  const isolated = components.filter((c) => c.length === 1).length;

  noteEl.textContent =
    components.length === 1
      ? `Los ${total.toLocaleString("es-PE")} establecimientos forman un único componente: ningún nodo está aislado de la red de referencia.`
      : `Se encontraron ${components.length} componentes independientes${isolated ? `, ${isolated} de ellos establecimientos aislados sin ninguna conexión` : ""}.`;

  const listEl = document.getElementById("cc-component-list");
  const colors = ["#1D6FA5", "#2F9E6E", "#E8622C", "#6D5BD0", "#B0399B", "#0EA5B5", "#C48A1E"];

  listEl.innerHTML = components
    .map((comp, i) => {
      const color = colors[i % colors.length];
      const members = comp
        .map((id) => {
          const n = nodes[id];
          return `<span class="member-chip" style="--dot-color:${color}">${escapeHtml(n ? n.name : id)}</span>`;
        })
        .join("");
      return `
        <details class="component-card" ${i === 0 ? "open" : ""}>
          <summary>
            <span class="component-swatch" style="background:${color}"></span>
            Componente ${i + 1} — ${comp.length.toLocaleString("es-PE")} establecimiento${comp.length === 1 ? "" : "s"}
          </summary>
          <div class="component-members">${members}</div>
        </details>`;
    })
    .join("");
}

function drawConnectedComponents(components) {
  clearAllLines();
  const colors = ["#1D6FA5", "#2F9E6E", "#E8622C", "#6D5BD0", "#B0399B", "#0EA5B5", "#C48A1E"];

  components.forEach((comp, i) => {
    if (comp.length < 2) return;
    const compSet = new Set(comp);
    const segments = [];
    const seen = new Set();

    comp.forEach((u) => {
      (undirectedAdj[u] || new Set()).forEach((v) => {
        if (!compSet.has(v)) return;
        const key = u < v ? `${u}|${v}` : `${v}|${u}`;
        if (seen.has(key)) return;
        seen.add(key);
        const nu = nodes[u], nv = nodes[v];
        if (!nu || !nv || nu.lat == null || nv.lat == null) return;
        segments.push([[nu.lat, nu.lon], [nv.lat, nv.lon]]);
      });
    });

    if (!segments.length) return;
    const weight = segments.length > 500 ? 1 : 2;
    const opacity = segments.length > 500 ? 0.35 : 0.85;
    const line = L.polyline(segments, { color: colors[i % colors.length], weight, opacity }).addTo(map);
    ccLines.push(line);
    animatePolylineDraw(line, 1200, i * 120);
  });

  if (ccLines.length) {
    const group = L.featureGroup(ccLines);
    map.flyToBounds(group.getBounds(), { padding: [40, 40], duration: 0.7 });
  }
}

/*********************************************************
 *  TABS
 *********************************************************/
function initTabs() {
  document.querySelectorAll(".tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      const id = tabBtn.getAttribute("data-tab");
      activeTabId = id;

      document.querySelectorAll(".tab").forEach((t) => {
        t.classList.toggle("active", t === tabBtn);
        t.setAttribute("aria-selected", t === tabBtn ? "true" : "false");
      });
      document.querySelectorAll(".tab-panel").forEach((p) => {
        p.classList.toggle("active", p.getAttribute("data-tab-panel") === id);
      });
    });
  });
}

/*********************************************************
 *  EVENTOS DE BOTONES PRINCIPALES
 *********************************************************/
function initActionButtons() {
  const dijkstraBtn = document.getElementById("btn-calc-dijkstra");
  if (dijkstraBtn) dijkstraBtn.addEventListener("click", runDijkstra);

  const mstBtn = document.getElementById("btn-run-mst");
  if (mstBtn) mstBtn.addEventListener("click", runMST);

  const ccBtn = document.getElementById("btn-run-cc");
  if (ccBtn) ccBtn.addEventListener("click", runConnectedComponents);

  const retryBtn = document.getElementById("btn-retry-load");
  if (retryBtn) retryBtn.addEventListener("click", () => { loadCSV(); });
}

/*********************************************************
 *  EJECUCIÓN INICIAL
 *********************************************************/
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  initTabs();
  initComboFields();
  initActionButtons();
  setActionsEnabled(false);
  loadCSV();
});
