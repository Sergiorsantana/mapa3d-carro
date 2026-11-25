/* Mapa 3D no Carro — mapa 3D da cidade em tempo real usando GPS + IA na câmera.
 * Mapas: OpenFreeMap (dados OpenStreetMap), sem chave de API.
 * Render: MapLibre GL JS + Three.js.  IA: MediaPipe (no próprio aparelho).
 */
import { criarCamada3D } from './cena3d.js?v=6';
import { PercepcaoIA, TrafegoSimulado, NOMES } from './ia.js?v=5';

(() => {
  'use strict';

  const STYLES = {
    dia: 'https://tiles.openfreemap.org/styles/liberty',
    noite: 'https://tiles.openfreemap.org/styles/dark',
  };
  // Imagens de satélite (Esri World Imagery — gratuito, sem chave, exige atribuição)
  const SATELITE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const TEMAS = ['satelite', 'dia', 'noite'];
  const ICONE_TEMA = { satelite: '🛰', dia: '☀', noite: '☾' };

  // Monta o estilo satélite: foto aérea no fundo + ruas e nomes do OpenStreetMap por cima.
  let estiloSateliteCache = null;
  async function estiloSatelite() {
    if (estiloSateliteCache) return estiloSateliteCache;
    const st = await fetch(STYLES.dia).then((r) => r.json());
    st.sources.satelite = {
      type: 'raster', tiles: [SATELITE], tileSize: 256, maxzoom: 19,
      attribution: 'Imagens © Esri, Maxar, Earthstar Geographics',
    };
    // Tira as áreas pintadas (parques, água, quadras) para a foto aparecer.
    st.layers = st.layers.filter((l) => l.type !== 'fill');
    const fundo = st.layers.findIndex((l) => l.type === 'background');
    st.layers.splice(fundo + 1, 0, {
      id: 'satelite', type: 'raster', source: 'satelite',
      paint: { 'raster-saturation': 0.2, 'raster-contrast': 0.12, 'raster-resampling': 'linear', 'raster-fade-duration': 150 },
    });
    // A foto já mostra as ruas: tira as linhas de rua/ferrovia e deixa só os nomes.
    st.layers = st.layers.filter((l) => !(l.type === 'line' && ['transportation', 'aeroway'].includes(l['source-layer'])));
    // Sem ícones de lojas e pontos de interesse: a foto fica limpa, só com nomes de ruas e bairros.
    st.layers = st.layers.filter((l) => l['source-layer'] !== 'poi');
    for (const l of st.layers) {
      if (l.type === 'line') l.paint = { ...l.paint, 'line-opacity': 0.45 };
      if (l.type === 'symbol' && l.paint) l.paint = { ...l.paint, 'text-halo-color': 'rgba(0,0,0,0.75)', 'text-color': '#ffffff' };
    }
    estiloSateliteCache = st;
    return st;
  }
  const START = [-46.6533, -23.5614]; // Av. Paulista, São Paulo (antes do 1º GPS)
  const PITCH_3D = 70;

  // ---------- Estado ----------
  const state = {
    tema: 'satelite',
    follow: true,
    autoZoom: true,
    is3d: true,
    pos: null,          // [lng, lat] exibida (interpolada)
    bearing: 0,         // rumo exibido
    heading: 0,         // último rumo calculado
    zoom: 19,
    zoomAlvo: 19,
    anim: null,         // {from, to, b0, b1, t0, dur}
    lastFix: null,      // {lng, lat, t}
    trilha: [],         // [[lng, lat, ele, time]]
    distancia: 0,       // metros
    vmax: 0,
    inicio: null,
    wakeLock: null,
    percepcao: null,    // PercepcaoIA ou TrafegoSimulado
  };

  // ---------- Mapa ----------
  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: {}, layers: [{ id: 'fundo', type: 'background', paint: { 'background-color': '#0b1220' } }] },
    center: START,
    zoom: 16,
    pitch: PITCH_3D,
    bearing: -20,
    maxPitch: 85,
    antialias: true,
    attributionControl: { compact: true },
  });

  map.on('style.load', () => {
    adicionarPredios3D();
    adicionarTrilha();
    if (!map.getLayer(cena.layer.id)) map.addLayer(cena.layer);
  });

  function fonteVetorial() {
    const srcs = map.getStyle().sources;
    if (srcs.openmaptiles) return 'openmaptiles';
    return Object.keys(srcs).find((k) => srcs[k].type === 'vector');
  }

  function adicionarPredios3D() {
    const style = map.getStyle();
    // Esconde extrusões do estilo original para usar a nossa (mais bonita e com cor por altura).
    style.layers.forEach((l) => {
      if (l.type === 'fill-extrusion') map.setLayoutProperty(l.id, 'visibility', 'none');
    });
    const src = fonteVetorial();
    if (!src || map.getLayer('predios-3d')) return;
    const primeiroTexto = style.layers.find((l) => l.type === 'symbol')?.id;
    const noite = state.tema === 'noite';
    const altura = ['coalesce', ['get', 'render_height'], ['get', 'height'], 6];
    // Paletas coloridas por altura: baixos quentes, altos frios/vibrantes.
    const cores = noite
      ? ['#3a2a5e', '#1f6f8b', '#2d9cdb', '#9b51e0', '#ff4fa3']
      : ['#ffd166', '#06d6a0', '#3aa8ff', '#8f5cff', '#ff4f8b'];

    map.addLayer({
      id: 'predios-3d',
      type: 'fill-extrusion',
      source: src,
      'source-layer': 'building',
      minzoom: 13,
      // Ignora estruturas sem altura (estações subterrâneas, coberturas), que viram "placas" no chão
      filter: ['>', ['coalesce', ['get', 'render_height'], ['get', 'height'], 6], 2],
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], altura,
          0, cores[0], 12, cores[1], 35, cores[2], 80, cores[3], 160, cores[4],
        ],
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, altura],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': state.tema === 'satelite' ? 0.3 : noite ? 0.78 : 0.72,
        'fill-extrusion-vertical-gradient': true,
      },
    }, primeiroTexto);
  }

  function adicionarTrilha() {
    if (map.getSource('trilha')) return;
    map.addSource('trilha', { type: 'geojson', data: trilhaGeoJSON() });
    map.addLayer({
      id: 'trilha-borda', type: 'line', source: 'trilha',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0b2a66', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 18, 14], 'line-opacity': 0.6 },
    });
    map.addLayer({
      id: 'trilha', type: 'line', source: 'trilha',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#3d8bff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 18, 8] },
    });
  }

  // A linha termina exatamente onde o carro está desenhado (e não no último ponto do GPS).
  function trilhaGeoJSON() {
    const coords = state.trilha.slice(0, -1).map((p) => [p[0], p[1]]);
    if (state.pos) coords.push(state.pos);
    return {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {},
    };
  }

  // ---------- Carro e objetos em 3D ----------
  // No satélite a câmera fica mais longe, então os objetos são desenhados maiores para continuar legíveis.
  const cena = criarCamada3D(() => ({ pos: state.pos, bearing: state.bearing, escala: state.tema === 'satelite' ? 1.7 : 1 }));
  window.mapa3d = { map, state, cena }; // útil para depurar no console

  // ---------- Utilidades geo ----------
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function distancia(a, b) {
    const dLat = rad(b[1] - a[1]);
    const dLng = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function rumo(a, b) {
    const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
    const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function lerpAngulo(a, b, t) {
    const d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
  }
  const lerp = (a, b, t) => a + (b - a) * t;

  // Câmera bem perto do carro (estilo "Reality View"); afasta conforme a velocidade.
  // No satélite a câmera fica um pouco mais longe: a foto da Esri só tem detalhe até o
  // nível 19, e chegar mais perto que isso só amplia os pixels (imagem turva).
  function zoomPorVelocidade(kmh) {
    const sat = state.tema === 'satelite';
    if (kmh < 15) return sat ? 18.3 : 20;
    if (kmh < 40) return sat ? 18.1 : 19.7;
    if (kmh < 70) return sat ? 17.8 : 19.2;
    return sat ? 17.4 : 18.6;
  }
  // Inclinação da câmera: menor no satélite para mostrar mais foto nítida perto do carro.
  const pitch3d = () => (state.tema === 'satelite' ? 62 : PITCH_3D);

  // ---------- Nova posição (GPS ou simulação) ----------
  function novaPosicao({ lng, lat, speed, heading, accuracy, altitude, t }) {
    const p = [lng, lat];
    const agora = t || Date.now();
    let kmh = speed != null && !Number.isNaN(speed) ? speed * 3.6 : null;

    if (state.lastFix) {
      const anterior = [state.lastFix.lng, state.lastFix.lat];
      const d = distancia(anterior, p);
      const dt = (agora - state.lastFix.t) / 1000;
      if (kmh == null && dt > 0) kmh = (d / dt) * 3.6;
      // Rumo: usa o do GPS quando em movimento, senão calcula pelo deslocamento.
      if (heading != null && !Number.isNaN(heading) && kmh > 3) state.heading = heading;
      else if (d > 4) state.heading = rumo(anterior, p);
      // Ignora tremidas do GPS parado.
      if (d > 2 && (accuracy == null || accuracy < 50)) {
        state.distancia += d;
        state.trilha.push([lng, lat, altitude ?? null, new Date(agora).toISOString()]);
      }
    } else {
      state.inicio = agora;
      state.trilha.push([lng, lat, altitude ?? null, new Date(agora).toISOString()]);
      state.pos = p;
      state.bearing = state.heading;
      state.zoom = state.zoomAlvo;
      map.jumpTo({ center: p, zoom: state.zoom, pitch: state.is3d ? pitch3d() : 0 });
    }

    kmh = Math.max(0, kmh || 0);
    if (state.percepcao instanceof TrafegoSimulado) state.percepcao.velocidade = kmh / 3.6;
    state.vmax = Math.max(state.vmax, kmh);
    if (state.autoZoom) state.zoomAlvo = zoomPorVelocidade(kmh);

    // Animação suave da posição anterior até a nova
    const dur = state.lastFix ? Math.min(Math.max(agora - state.lastFix.t, 300), 2000) : 0;
    state.anim = { from: state.pos, to: p, b0: state.bearing, b1: state.heading, t0: performance.now(), dur };
    state.lastFix = { lng, lat, t: agora };

    atualizarHUD(kmh, accuracy);
  }

  // ---------- Loop de animação ----------
  let ultimoHudIA = 0, ultimaTrilha = 0;
  function frame(now) {
    if (state.pos && now - ultimaTrilha > 150) {
      ultimaTrilha = now;
      map.getSource('trilha')?.setData(trilhaGeoJSON());
    }
    if (state.percepcao) {
      const objs = state.percepcao.objetos();
      cena.setObjetos(objs);
      if (now - ultimoHudIA > 500) { ultimoHudIA = now; hudIA(objs); }
    }
    const a = state.anim;
    if (a) {
      const t = a.dur ? Math.min(1, (now - a.t0) / a.dur) : 1;
      state.pos = [lerp(a.from[0], a.to[0], t), lerp(a.from[1], a.to[1], t)];
      state.bearing = lerpAngulo(a.b0, a.b1, t);
      if (state.follow) {
        state.zoom += (state.zoomAlvo - state.zoom) * 0.03;
        map.jumpTo({ center: state.pos, bearing: state.bearing, zoom: state.autoZoom ? state.zoom : map.getZoom() });
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Carro fica na parte de baixo da tela, para ver mais à frente.
  function ajustarPadding() {
    map.setPadding({ top: Math.round(window.innerHeight * 0.35), bottom: 0, left: 0, right: 0 });
  }
  window.addEventListener('resize', ajustarPadding);
  ajustarPadding();

  // ---------- HUD ----------
  const $ = (id) => document.getElementById(id);
  function atualizarHUD(kmh, accuracy) {
    $('spd').textContent = Math.round(kmh);
    $('dist').textContent = (state.distancia / 1000).toFixed(2).replace('.', ',') + ' km';
    $('vmax').textContent = Math.round(state.vmax) + ' km/h';
    $('acc').textContent = accuracy != null ? '±' + Math.round(accuracy) + ' m' : '–';
  }
  setInterval(() => {
    if (!state.inicio) return;
    const s = Math.floor((Date.now() - state.inicio) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    $('time').textContent = (h ? h + ':' : '') + pad(m) + ':' + pad(ss);
  }, 1000);

  function hudIA(objs) {
    const cont = {};
    let sem = null;
    for (const o of objs) {
      cont[o.tipo] = (cont[o.tipo] || 0) + 1;
      if (o.tipo === 'semaforo' && o.z > 0 && (!sem || o.z < sem.z)) sem = o;
    }
    const partes = Object.entries(cont).filter(([t]) => t !== 'semaforo').map(([t, n]) => `${n} ${NOMES[t].toLowerCase()}${n > 1 ? 's' : ''}`);
    const fps = state.percepcao.fps ? ` · ${Math.round(state.percepcao.fps)} fps` : '';
    $('ia').textContent = (partes.join(' · ') || 'Nada detectado') + fps;
    const luz = $('luz');
    luz.className = 'luz ' + (sem?.cor || '');
    luz.classList.toggle('hidden', !sem);
    if (sem) luz.title = `Semáforo a ${Math.round(sem.z)} m`;
  }

  function setStatus(msg, tipo) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status ' + (tipo || '');
  }

  // ---------- Seguir / interação do usuário ----------
  function setFollow(v) {
    state.follow = v;
    $('btnCenter').classList.toggle('active', v);
    if (v) {
      state.autoZoom = true;
      state.zoom = map.getZoom();
    }
  }
  ['dragstart', 'rotatestart', 'pitchstart'].forEach((ev) =>
    map.on(ev, (e) => { if (e.originalEvent) setFollow(false); }));
  map.on('zoomstart', (e) => { if (e.originalEvent) state.autoZoom = false; });

  // ---------- GPS ----------
  function iniciarGPS() {
    if (!('geolocation' in navigator)) {
      setStatus('Este aparelho não tem GPS disponível.', 'warn');
      return;
    }
    if (!window.isSecureContext) {
      setStatus('O GPS exige HTTPS (ex.: GitHub Pages).', 'warn');
    }
    navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        setStatus('GPS ativo', 'ok');
        novaPosicao({
          lng: c.longitude, lat: c.latitude, speed: c.speed, heading: c.heading,
          accuracy: c.accuracy, altitude: c.altitude, t: pos.timestamp,
        });
      },
      (err) => {
        const msgs = { 1: 'Permissão de localização negada.', 2: 'Sinal de GPS indisponível.', 3: 'GPS demorou para responder…' };
        setStatus(msgs[err.code] || err.message, 'warn');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  }

  // ---------- Modo demonstração (vai e volta pela Av. Paulista, SP) ----------
  // Traçado real do canteiro central da Av. Paulista (dados OpenStreetMap)
  const IDA = [
    [-46.66271, -23.55597], [-46.66128, -23.55724], [-46.65993, -23.55835], [-46.65840, -23.55969],
    [-46.65611, -23.56177], [-46.65418, -23.56336], [-46.65266, -23.56462], [-46.64908, -23.56760],
    [-46.64726, -23.56899], [-46.64467, -23.57097],
  ];
  const ROTA_DEMO = [...IDA, ...IDA.slice(1, -1).reverse()];
  const LADO_DIREITO = 6; // metros à direita do canteiro (pista de quem vai no sentido)
  function iniciarDemo() {
    setStatus('Modo demonstração', 'ok');
    const kmh = 45;
    const passo = (kmh / 3.6) * 1; // metros por segundo
    let seg = 0, dist = 0;
    setInterval(() => {
      let a = ROTA_DEMO[seg], b = ROTA_DEMO[(seg + 1) % ROTA_DEMO.length];
      dist += passo;
      let L = distancia(a, b);
      while (dist > L) {
        dist -= L;
        seg = (seg + 1) % ROTA_DEMO.length;
        a = ROTA_DEMO[seg]; b = ROTA_DEMO[(seg + 1) % ROTA_DEMO.length];
        L = distancia(a, b);
      }
      const t = dist / L;
      const v = kmh + Math.sin(Date.now() / 4000) * 8;
      // Desloca para a pista da direita
      const br = rad(rumo(a, b));
      const lat0 = lerp(a[1], b[1], t);
      const dLng = (Math.cos(br) * LADO_DIREITO) / (111320 * Math.cos(rad(lat0)));
      const dLat = (-Math.sin(br) * LADO_DIREITO) / 110540;
      novaPosicao({ lng: lerp(a[0], b[0], t) + dLng, lat: lat0 + dLat, speed: v / 3.6, heading: rumo(a, b), accuracy: 5, altitude: 800 });
    }, 1000);
  }

  // ---------- Tela ligada ----------
  async function manterTelaLigada() {
    try {
      if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) { /* sem suporte */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.inicio) manterTelaLigada();
  });

  // ---------- Exportar GPX ----------
  function exportarGPX() {
    if (state.trilha.length < 2) { alert('Ainda não há trajeto gravado.'); return; }
    const pts = state.trilha.map(([lng, lat, ele, time]) =>
      `      <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}">${ele != null ? `<ele>${ele.toFixed(1)}</ele>` : ''}<time>${time}</time></trkpt>`
    ).join('\n');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mapa 3D no Carro" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Trajeto ${new Date().toLocaleString('pt-BR')}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>`;
    const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `trajeto-${Date.now()}.gpx` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- Botões ----------
  async function iniciarCameraIA() {
    $('cam').classList.remove('hidden');
    $('btnCam').classList.add('active');
    state.percepcao = new PercepcaoIA({
      video: $('video'), overlay: $('overlay'),
      onStatus: (m) => { $('ia').textContent = m; },
    });
    try {
      await state.percepcao.iniciar();
    } catch (e) {
      state.percepcao = null;
      $('cam').classList.add('hidden');
      $('ia').textContent = 'Câmera/IA indisponível: ' + (e.message || e.name);
    }
  }

  function comecar(modo) {
    $('start').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('controls').classList.remove('hidden');
    setFollow(true);
    manterTelaLigada();
    if (modo === 'demo') {
      state.percepcao = new TrafegoSimulado();
      iniciarDemo();
    } else {
      iniciarGPS();
      if (modo === 'ia') iniciarCameraIA();
      else $('ia').textContent = 'Câmera desligada';
    }
  }
  $('btnIa').onclick = () => comecar('ia');
  $('btnGps').onclick = () => comecar('gps');
  $('btnDemo').onclick = () => comecar('demo');
  $('btnCam').onclick = () => {
    if (!state.percepcao) { iniciarCameraIA(); return; }
    if (!(state.percepcao instanceof PercepcaoIA)) return;
    const oculto = $('cam').classList.toggle('hidden');
    $('btnCam').classList.toggle('active', !oculto);
  };
  $('btnCenter').onclick = () => setFollow(true);
  $('btn3d').onclick = () => {
    state.is3d = !state.is3d;
    $('btn3d').textContent = state.is3d ? '2D' : '3D';
    map.easeTo({ pitch: state.is3d ? pitch3d() : 0, duration: 800 });
  };
  async function setTema(tema) {
    state.tema = tema;
    $('btnTheme').textContent = ICONE_TEMA[tema];
    $('btnTheme').title = { satelite: 'Satélite', dia: 'Mapa claro', noite: 'Mapa noturno' }[tema] + ' (toque para trocar)';
    let estilo = STYLES[tema];
    if (tema === 'satelite') {
      try { estilo = await estiloSatelite(); } catch (_) { estilo = STYLES.dia; }
    }
    map.setStyle(estilo, { diff: false });
    if (state.lastFix) {
      const kmh = state.vmax ? parseFloat($('spd').textContent) || 0 : 0;
      state.zoomAlvo = zoomPorVelocidade(kmh);
    }
    if (state.is3d) map.easeTo({ pitch: pitch3d(), duration: 600 });
  }
  // Satélite → claro → noturno → satélite…
  $('btnTheme').onclick = () => setTema(TEMAS[(TEMAS.indexOf(state.tema) + 1) % TEMAS.length]);
  $('btnGpx').onclick = exportarGPX;
  $('btnFull').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  // Satélite de dia, mapa noturno entre 18h e 6h
  const h = new Date().getHours();
  setTema(h >= 18 || h < 6 ? 'noite' : 'satelite');

  // ---------- PWA ----------
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
