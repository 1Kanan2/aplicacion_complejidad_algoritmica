/*********************************************************
 *  CONFIGURACIÓN INICIAL
 *********************************************************/

let graph = {};              // Nodos -> lista de aristas
let nodes = {};              // Info de cada nodo (lat, lon, nombre…)
let map;
let markers = [];
let mstLines = [];
let ccLines = [];
let routeLine = null;

/*********************************************************
 *  INICIALIZAR MAPA
 *********************************************************/
function initMap() {
  map = L.map("map").setView([-12.0464, -77.0428], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
  }).addTo(map);
}

/*********************************************************
 *  UTIL - split CSV LINE respetando comillas
 *********************************************************/
function splitCSVLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      // escaped quote inside quoted field -> add a single quote and skip next
      cur += '"';
      i++; // skip next
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

/*********************************************************
 *  FIX JSON-FIELD: quita quotes externas y "" -> "
 *********************************************************/
function normalizeJsonField(field) {
  if (field == null) return "[]";
  let s = field.trim();
  // si viene con comillas externas que envuelven todo, quítalas
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  // reemplazar "" por " (CSV dup-escape)
  s = s.replace(/""/g, '"');
  return s;
}

/*********************************************************
 *  CARGA DEL CSV Y CONSTRUCCIÓN DEL GRAFO
 *  - intenta peru_red_referencias_10reg.csv, sino data.csv
 *********************************************************/
async function loadCSV() {
  let csvName = "peru_red_referencias_10reg.csv";
  let resp;
  try {
    resp = await fetch(csvName);
    if (!resp.ok) throw new Error("no encontrado");
  } catch (e) {
    // fallback
    try {
      csvName = "data.csv";
      resp = await fetch(csvName);
      if (!resp.ok) throw new Error("no encontrado fallback");
    } catch (e2) {
      console.error("No pude encontrar el CSV en:", e, e2);
      alert("No se encontró el CSV ('peru_red_referencias_10reg.csv' o 'data.csv'). Coloca el CSV en la carpeta del proyecto.");
      return;
    }
  }

  const csvTextRaw = await resp.text();
  // Normalizar saltos de linea
  const csvText = csvTextRaw.replace(/\r\n/g, "\n").trim();
  const rows = csvText.split("\n").filter(r => r.trim().length > 0);

  // Reiniciar estructuras
  graph = {};
  nodes = {};

  rows.forEach((row, idx) => {
    // evitar header: si detectamos que la fila empieza por "id," o "id;" podemos saltarla
    if (idx === 0 && /^id[,;]/i.test(row)) {
      return;
    }

    // parsear respetando comillas
    const parts = splitCSVLine(row);

    // Esperamos al menos 9 columnas: id,name,region,level,type,lat,lon,relations,services
    if (parts.length < 8) {
      console.warn("Fila con columnas inesperadas, se ignora:", idx + 1, row);
      return;
    }

    const [
      idRaw,
      nameRaw,
      regionRaw,
      levelRaw,
      typeRaw,
      latRaw,
      lonRaw,
      relationsRaw = "[]",
      servicesRaw = "[]"
    ] = parts;

    const id = (idRaw || "").trim();
    if (!id) return;

    const name = (nameRaw || "").trim();
    const region = (regionRaw || "").trim();
    const level = (levelRaw || "").trim();
    const tipo = (typeRaw || "").trim();
    const lat = Number((latRaw || "").trim());
    const lon = Number((lonRaw || "").trim());

    // normalizar y parsear relations y services - manejo robusto
    const relationsJsonText = normalizeJsonField(relationsRaw);
    let relations = [];
    try {
      relations = JSON.parse(relationsJsonText);
      if (!Array.isArray(relations)) relations = [];
    } catch (e) {
      console.warn("No pude parsear relations en fila", idx + 1, "->", relationsJsonText);
      relations = [];
    }

    const servicesJsonText = normalizeJsonField(servicesRaw);
    let services = [];
    try {
      services = JSON.parse(servicesJsonText);
      if (!Array.isArray(services)) services = [];
    } catch (e) {
      console.warn("No pude parsear services en fila", idx + 1, "->", servicesJsonText);
      services = [];
    }

    // Guardamos info del nodo (si ya existía, preservamos posible info previa)
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

    // Inicializar lista de adyacencia si no existe
    if (!graph[id]) graph[id] = [];

    // Agregar aristas (y también asegurar que el nodo target exista en graph, para evitar dist undefined)
    relations.forEach(rel => {
      const target = String(rel.target_id || "").trim();
      const weight = Number(rel.weight_km);
      if (!target || !isFinite(weight)) return;

      graph[id].push({ target, weight });

      // asegurar entrada para el target (aunque no tenga coords aún)
      if (!graph[target]) graph[target] = [];
      if (!nodes[target]) {
        // placeholder sin coords (posible que se defina más adelante en el CSV)
        nodes[target] = nodes[target] || { id: target, name: target, lat: null, lon: null, region: null, level: null, relations: [], services: [] };
      }
    });
  });

  drawNodesOnMap();
}

/*********************************************************
 *  DIBUJAR NODOS EN EL MAPA
 *********************************************************/
function drawNodesOnMap() {
  // limpiar markers previos
  markers.forEach(m => {
    try { map.removeLayer(m); } catch (e) {}
  });
  markers = [];

  Object.values(nodes).forEach(n => {
    // solo dibujar si tiene coordenadas válidas
    if (n.lat == null || n.lon == null || Number.isNaN(n.lat) || Number.isNaN(n.lon)) return;

    const marker = L.circleMarker([n.lat, n.lon], {
      radius: 6,
      color: colorPorNivel(n.level),
      fillColor: colorPorNivel(n.level),
      fillOpacity: 0.9
    })
      .addTo(map)
      .bindPopup(`<b>${escapeHtml(n.name)}</b><br>${n.id}<br>${n.region || ""}<br>${n.level || ""}`);

    markers.push(marker);
  });
}

/*********************************************************
 *  UTIL - color por nivel
 *********************************************************/
function colorPorNivel(level) {
  const lv = (level || "").toString().toUpperCase();
  if (lv.startsWith("I-") || lv.startsWith("I")) return "#16a34a";
  if (lv.startsWith("II")) return "#f97316";
  if (lv.startsWith("III")) return "#ef4444";
  return "#64748b";
}

/*********************************************************
 *  UTIL - escape HTML en popups
 *********************************************************/
function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/[&<>"']/g, function (m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
  });
}

/*********************************************************
 *  LIMPIEZA DE LÍNEAS
 *********************************************************/
function clearAllLines() {
  try { if (routeLine) map.removeLayer(routeLine); } catch (e) {}
  routeLine = null;

  mstLines.forEach(l => { try { map.removeLayer(l); } catch (e) {} });
  mstLines = [];

  ccLines.forEach(l => { try { map.removeLayer(l); } catch (e) {} });
  ccLines = [];
}

/*********************************************************
 *  DIJKSTRA
 *********************************************************/
function runDijkstra() {
  const origenEl = document.getElementById("origen");
  const destinoEl = document.getElementById("destino");
  if (!origenEl || !destinoEl) {
    alert("Elementos origen/destino no encontrados en el DOM.");
    return;
  }

  const origen = origenEl.value.trim();
  const destino = destinoEl.value.trim();

  if (!graph[origen] || !graph[destino]) {
    const msgEl = document.getElementById("resultado-dijkstra");
    if (msgEl) msgEl.innerText = "❌ Los nodos ingresados no existen o faltan en la red.";
    return;
  }

  const { dist, prev } = dijkstra(origen);
  const path = getPath(prev, origen, destino);

  const msgEl = document.getElementById("resultado-dijkstra");
  if (!path || path.length === 0) {
    if (msgEl) msgEl.innerText = "❌ No existe ruta.";
    clearAllLines();
    return;
  }

  if (msgEl) msgEl.innerText = "Ruta:\n" + path.join(" → ") + `\n\nDistancia total: ${Number(dist[destino]).toFixed(2)} km`;

  drawRouteOnMap(path);
}

/********** ALGORITMO **********/
function dijkstra(start) {
  const dist = {};
  const prev = {};
  const visited = new Set();

  // inicializar dist para todos los nodos que aparecen en graph (incluye targets agregados)
  Object.keys(graph).forEach(n => {
    dist[n] = Infinity;
    prev[n] = null;
  });

  if (!(start in dist)) {
    // nodo de inicio desconocido, retornar vacío
    return { dist, prev };
  }

  dist[start] = 0;

  while (true) {
    // elegir el no visitado con menor dist
    let u = null;
    let min = Infinity;
    for (const k of Object.keys(dist)) {
      if (!visited.has(k) && dist[k] < min) {
        min = dist[k];
        u = k;
      }
    }
    if (u === null) break;

    visited.add(u);

    const adj = graph[u] || [];
    for (const edge of adj) {
      const v = edge.target;
      const w = Number(edge.weight) || 0;
      if (!(v in dist)) {
        // si el target no estaba en dist (caso raro), inicializarlo
        dist[v] = Infinity;
        prev[v] = null;
      }
      const alt = dist[u] + w;
      if (alt < dist[v]) {
        dist[v] = alt;
        prev[v] = u;
      }
    }
  }

  return { dist, prev };
}

function getPath(prev, start, end) {
  const path = [];
  let u = end;
  // si end no está en prev y no es start -> no hay ruta
  if (!(end in prev) && end !== start) return [];
  while (u != null) {
    path.unshift(u);
    if (u === start) break;
    u = prev[u];
  }
  return path[0] === start ? path : [];
}

/*********************************************************
 *  DIBUJAR RUTA DIJKSTRA
 *********************************************************/
function drawRouteOnMap(path) {
  clearAllLines();

  const latlngs = [];
  path.forEach(id => {
    const n = nodes[id];
    if (!n || n.lat == null || n.lon == null) return;
    latlngs.push([n.lat, n.lon]);
  });

  if (latlngs.length === 0) return;

  routeLine = L.polyline(latlngs, {
    color: "#00ffbf",
    weight: 5
  }).addTo(map);

  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
}

/*********************************************************
 *  MST (KRUSKAL)
 *********************************************************/
function runMST() {
  const edges = [];

  // Convertir lista de adyacencia en lista de aristas
  Object.keys(graph).forEach(u => {
    (graph[u] || []).forEach(v => {
      // evitar duplicados en caso de tener ambas direcciones; incluirlos igual para Kruskal está bien
      edges.push({ u, v: v.target, w: Number(v.weight) || 0 });
    });
  });

  // Ordenar por peso
  edges.sort((a, b) => a.w - b.w);

  // Union-Find
  const parent = {};
  Object.keys(nodes).forEach(n => (parent[n] = n));
  // Asegurar también targets que existen en graph pero no en nodes
  Object.keys(graph).forEach(n => { if (!parent[n]) parent[n] = n; });

  function find(x) {
    if (parent[x] === undefined) parent[x] = x;
    return parent[x] === x ? x : (parent[x] = find(parent[x]));
  }
  function unite(a, b) {
    parent[find(a)] = find(b);
  }

  const mst = [];

  edges.forEach(e => {
    if (find(e.u) !== find(e.v)) {
      unite(e.u, e.v);
      mst.push(e);
    }
  });

  const outEl = document.getElementById("resultado-mst");
  if (outEl) outEl.innerText = mst.map(e => `${e.u} — ${e.v} : ${e.w.toFixed(2)} km`).join("\n");

  drawMST(mst);
}

function drawMST(mst) {
  clearAllLines();

  mst.forEach(e => {
    const nu = nodes[e.u];
    const nv = nodes[e.v];
    if (!nu || !nv || nu.lat == null || nv.lat == null) return;

    const line = L.polyline(
      [
        [nu.lat, nu.lon],
        [nv.lat, nv.lon]
      ],
      { color: "#0084ff", weight: 3, opacity: 0.9 }
    ).addTo(map);

    mstLines.push(line);
  });

  // ajustar vista si hay líneas
  if (mstLines.length) {
    const group = L.featureGroup(mstLines);
    map.fitBounds(group.getBounds(), { padding: [30, 30] });
  }
}

/*********************************************************
 *  COMPONENTES CONEXAS
 *********************************************************/
function runConnectedComponents() {
  const visited = {};
  const result = [];
  Object.keys(graph).forEach(n => visited[n] = false);

  Object.keys(graph).forEach(n => {
    if (!visited[n]) {
      const comp = [];
      dfs(n, visited, comp);
      result.push(comp);
    }
  });

  const outEl = document.getElementById("resultado-cc");
  if (outEl) outEl.innerText = result.map((c, i) => `Componente ${i + 1}:\n${c.join(", ")}\n`).join("\n");

  drawConnectedComponents(result);
}

function dfs(u, visited, comp) {
  visited[u] = true;
  comp.push(u);
  const adj = graph[u] || [];
  for (const edge of adj) {
    if (!visited[edge.target]) dfs(edge.target, visited, comp);
  }
}

/*********************************************************
 *  DIBUJAR COMPONENTES CONEXAS
 *********************************************************/
function drawConnectedComponents(components) {
  clearAllLines();

  const colors = ["#ff4444", "#44ff44", "#4488ff", "#ffbb00", "#ff00ff", "#00ffd5", "#d48cff"];

  components.forEach((comp, i) => {
    const color = colors[i % colors.length];

    comp.forEach(u => {
      const adj = graph[u] || [];
      adj.forEach(edge => {
        if (comp.includes(edge.target)) {
          const nu = nodes[u];
          const nv = nodes[edge.target];
          if (!nu || !nv || nu.lat == null || nv.lat == null) return;

          const line = L.polyline(
            [
              [nu.lat, nu.lon],
              [nv.lat, nv.lon]
            ],
            { color, weight: 2, opacity: 0.9 }
          ).addTo(map);

          ccLines.push(line);
        }
      });
    });
  });

  if (ccLines.length) {
    const group = L.featureGroup(ccLines);
    map.fitBounds(group.getBounds(), { padding: [30, 30] });
  }
}

/*********************************************************
 *  EJECUCIÓN INICIAL
 *********************************************************/
initMap();
loadCSV();
