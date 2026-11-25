/* Mapa 3D no Carro — mapa 3D da cidade em tempo real usando GPS + IA na câmera.
 * Mapas: OpenFreeMap (dados OpenStreetMap), sem chave de API.
 * Render: MapLibre GL JS + Three.js.  IA: MediaPipe (no próprio aparelho).
 */
import { criarCamada3D } from './cena3d.js?v=6';
import { PercepcaoIA, TrafegoSimulado, NOMES } from './ia.js?v=7';
import { AJUSTES, salvar, aoMudar, restaurarPadrao } from './ajustes.js?v=1';
import { INCLINACAO, iniciarSensores } from './sensores.js?v=1';
import { adicionarFaixas, mostrarFaixas } from './faixas.js?v=2';
import { AvisoDistancia, liberarSom, bipe } from './aviso.js?v=1';
import { Navegacao } from './navegacao.js?v=1';
import { LimiteVelocidade, classeDaVia } from './limite.js?v=1';
import { Dashcam } from './dashcam.js?v=1';
import { salvarViagem, listarViagens, apagarViagem, simplificar, gpxDaViagem } from './historico.js?v=1';

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
    vel: 0,             // velocidade atual (m/s)
    modo: null,         // 'ia' | 'gps' | 'demo'
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
    preserveDrawingBuffer: true, // permite gravar a tela (dashcam)
    attributionControl: { compact: true },
  });

  map.on('style.load', () => {
    adicionarPredios3D();
    const lat = (state.pos || START)[1];
    adicionarFaixas(map, fonteVetorial(), lat, AJUSTES.faixas);
    adicionarTrilha();
    navegacao.desenhar();
    if (viagemVista) mostrarViagem(viagemVista);
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
  const navegacao = new Navegacao(map, { banner: document.getElementById('banner') });
  const limite = new LimiteVelocidade();
  const aviso = new AvisoDistancia(document.getElementById('aviso'));
  const dashcam = new Dashcam(map, {
    video: document.getElementById('video'),
    overlay: document.getElementById('overlay'),
    painel: () => ({ vel: document.getElementById('spd').textContent, info: 'Mapa 3D no Carro · ' + (document.getElementById('ia').textContent || '') }),
  });
  let viagemVista = null; // viagem do histórico mostrada no mapa
  window.mapa3d = { map, state, cena, navegacao, limite }; // útil para depurar no console

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
    state.vel = kmh / 3.6;
    if (state.percepcao) state.percepcao.velocidade = state.vel;
    state.vmax = Math.max(state.vmax, kmh);
    if (state.autoZoom) state.zoomAlvo = zoomPorVelocidade(kmh);

    // Animação suave da posição anterior até a nova
    const dur = state.lastFix ? Math.min(Math.max(agora - state.lastFix.t, 300), 2000) : 0;
    state.anim = { from: state.pos, to: p, b0: state.bearing, b1: state.heading, t0: performance.now(), dur };
    state.lastFix = { lng, lat, t: agora };

    atualizarHUD(kmh, accuracy);
    navegacao.atualizar(p);
    atualizarLimite(p, kmh);
  }

  // ---------- Limite de velocidade ----------
  let ultimoLimite = 0, acimaAntes = false;
  async function atualizarLimite(p, kmh) {
    const agora = Date.now();
    if (agora - ultimoLimite > 2000) {
      ultimoLimite = agora;
      const classe = classeDaVia(map, fonteVetorial(), p[0], p[1]);
      await limite.atualizar(p[0], p[1], classe);
    }
    const l = limite.limite;
    const placa = $('placa');
    placa.classList.toggle('hidden', !l);
    if (!l) { $('hud').querySelector('.speed').classList.remove('acima'); return; }
    $('limiteVal').textContent = l.kmh;
    placa.classList.toggle('estimado', l.estimado);
    placa.title = l.estimado ? `Limite estimado pelo tipo de via (${l.kmh} km/h)` : `Limite da via: ${l.kmh} km/h`;
    // Alerta só com limite real da via (não com o estimado), com 5 km/h de tolerância
    const acima = !l.estimado && AJUSTES.avisoVelocidade && kmh > l.kmh + 5;
    placa.classList.toggle('acima', acima);
    $('hud').querySelector('.speed').classList.toggle('acima', acima);
    if (acima && !acimaAntes) bipe(600, 0.25, 2);
    acimaAntes = acima;
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
      if (now - ultimoHudIA > 250) { ultimoHudIA = now; hudIA(objs); aviso.atualizar(objs, state.vel); }
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
    const ECO = { parado: 'economia: parado', bateria: 'economia: bateria baixa', lento: 'economia: celular lento' };
    const eco = ECO[state.percepcao.modo] ? ` · ${ECO[state.percepcao.modo]}` : '';
    $('ia').textContent = (partes.join(' · ') || 'Nada detectado') + fps + eco;
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
    state.modo = modo;
    liberarSom();          // som precisa de um toque do usuário
    iniciarSensores();     // inclinação do celular (calibração automática do horizonte)
    setInterval(guardarViagem, 20000);
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

  // ---------- Painel lateral ----------
  function abrirPainel(titulo, corpo) {
    $('painelTitulo').textContent = titulo;
    const c = $('painelCorpo');
    c.innerHTML = '';
    c.append(corpo);
    $('painel').classList.remove('hidden');
  }
  const fecharPainel = () => $('painel').classList.add('hidden');
  $('painelFechar').onclick = fecharPainel;
  $('painel').onclick = (e) => { if (e.target.id === 'painel') fecharPainel(); };
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content;
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- Ajustes e calibração ----------
  function painelAjustes() {
    const f = el(`
      <h3>Calibração da câmera</h3>
      <p class="dica">Abra a câmera (📷) e deixe a <b style="color:#00e5ff">linha azul tracejada</b> na altura do fim da rua, lá longe.
      Isso deixa a distância dos carros mais precisa.</p>
      <label class="chave">Corrigir pela inclinação do celular (sensor)<input type="checkbox" data-k="sensorInclinacao"></label>
      <p class="dica" id="leituraSensor"></p>
      <div class="campo"><label>Ajuste fino do horizonte <b data-v="horizonteManual"></b></label>
        <input type="range" min="-25" max="25" step="0.5" data-k="horizonteManual"></div>
      <div class="campo"><label>Altura do celular em relação ao chão <b data-v="alturaCamera"></b></label>
        <input type="range" min="0.8" max="2.2" step="0.05" data-k="alturaCamera"></div>
      <div class="campo"><label>Campo de visão da câmera <b data-v="campoDeVisao"></b></label>
        <input type="range" min="45" max="100" step="1" data-k="campoDeVisao"></div>
      <h3>Inteligência artificial</h3>
      <div class="campo"><label>Modelo de detecção</label>
        <select data-k="modeloIA">
          <option value="rapido">Rápido (EfficientDet-Lite0, 4 MB)</option>
          <option value="preciso">Preciso (EfficientDet-Lite2, 12 MB — erra menos, gasta mais bateria)</option>
        </select></div>
      <label class="chave">Economia de bateria (reduz a IA parado, com bateria baixa ou celular lento/quente)<input type="checkbox" data-k="economia"></label>
      <h3>Avisos</h3>
      <label class="chave">Bipe de distância do carro da frente<input type="checkbox" data-k="somAviso"></label>
      <label class="chave">Alerta acima do limite de velocidade<input type="checkbox" data-k="avisoVelocidade"></label>
      <label class="chave">Voz da navegação<input type="checkbox" data-k="vozNavegacao"></label>
      <label class="chave">Mostrar faixas da rua<input type="checkbox" data-k="faixas"></label>
      <p class="dica">⚠️ Os avisos são só um auxílio: a distância vem de uma câmera só e é aproximada. Continue sempre atento ao trânsito.</p>
      <button class="btn perigo" id="ajPadrao">Restaurar padrão</button>`);
    const formatar = {
      horizonteManual: (v) => (v > 0 ? '+' : '') + v + '%',
      alturaCamera: (v) => (+v).toFixed(2).replace('.', ',') + ' m',
      campoDeVisao: (v) => v + '°',
    };
    const preencher = (raiz) => {
      raiz.querySelectorAll('[data-k]').forEach((inp) => {
        const k = inp.dataset.k;
        if (inp.type === 'checkbox') inp.checked = !!AJUSTES[k]; else inp.value = AJUSTES[k];
        const out = raiz.querySelector(`[data-v="${k}"]`);
        if (out) out.textContent = formatar[k](AJUSTES[k]);
      });
    };
    preencher(f);
    f.querySelectorAll('[data-k]').forEach((inp) => {
      inp.addEventListener(inp.type === 'range' ? 'input' : 'change', () => {
        const k = inp.dataset.k;
        const v = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' ? parseFloat(inp.value) : inp.value;
        salvar({ [k]: v });
        const out = $('painelCorpo').querySelector(`[data-v="${k}"]`);
        if (out) out.textContent = formatar[k](v);
      });
    });
    f.querySelector('#ajPadrao').onclick = () => { restaurarPadrao(); preencher($('painelCorpo')); };
    abrirPainel('Ajustes', f);
    const leitura = () => {
      const p = $('leituraSensor');
      if (!p || $('painel').classList.contains('hidden')) return;
      p.textContent = INCLINACAO.disponivel
        ? `Inclinação da câmera agora: ${(INCLINACAO.elevacao * 180 / Math.PI).toFixed(1).replace('.', ',')}° (${INCLINACAO.elevacao < 0 ? 'para baixo' : 'para cima'})`
        : 'Sensor de inclinação indisponível neste aparelho/navegador.';
      setTimeout(leitura, 500);
    };
    leitura();
  }
  aoMudar((m) => {
    if ('faixas' in m) mostrarFaixas(map, m.faixas);
    if ('modeloIA' in m && state.percepcao instanceof PercepcaoIA) {
      state.percepcao.trocarModelo(m.modeloIA).catch(() => { $('ia').textContent = 'Não foi possível carregar o modelo'; });
    }
  });
  $('btnAjustes').onclick = painelAjustes;

  // ---------- Navegação ----------
  function painelNavegacao() {
    const f = el(`
      <form class="busca" id="formBusca"><input id="qBusca" placeholder="Para onde? (endereço, lugar…)" autocomplete="off"><button class="btn primario">Buscar</button></form>
      <div id="resultados"></div>
      <p class="dica">A busca usa o OpenStreetMap (Nominatim) e a rota usa o OSRM, serviços gratuitos. O texto buscado e a sua posição são enviados a eles.</p>`);
    if (navegacao.rota) {
      const e = el(`<div class="viagem"><div class="titulo">Rota ativa</div><p class="dica">${esc(navegacao.rota.destino.nome)}</p><button class="btn perigo" id="encerrarRota">Encerrar rota</button></div>`);
      e.querySelector('#encerrarRota').onclick = () => { navegacao.encerrar(); fecharPainel(); };
      f.prepend(e);
    }
    abrirPainel('Navegar', f);
    const q = $('qBusca');
    setTimeout(() => q.focus(), 50);
    $('formBusca').onsubmit = async (ev) => {
      ev.preventDefault();
      const r = $('resultados');
      if (!q.value.trim()) return;
      r.innerHTML = '<p class="dica">Buscando…</p>';
      try {
        const lista = await navegacao.buscar(q.value.trim(), state.pos);
        r.innerHTML = lista.length ? '' : '<p class="dica">Nada encontrado. Tente incluir a cidade.</p>';
        for (const item of lista) {
          const d = document.createElement('div');
          d.className = 'resultado';
          d.textContent = item.nome;
          d.onclick = async () => {
            if (!state.pos) { d.textContent = 'Aguardando o GPS para calcular a rota…'; return; }
            d.textContent = 'Calculando rota…';
            try {
              await navegacao.iniciar(state.pos, item);
              fecharPainel();
              setFollow(true);
            } catch (e) { d.textContent = '⚠️ ' + e.message; }
          };
          r.append(d);
        }
      } catch (e) { r.innerHTML = `<p class="dica">⚠️ ${esc(e.message)}</p>`; }
    };
  }
  $('btnNav').onclick = painelNavegacao;
  $('btnFimRota').onclick = () => navegacao.encerrar();

  // ---------- Dashcam ----------
  let relogioRec = null;
  $('btnRec').onclick = () => {
    if (!Dashcam.suportado()) { alert('Este navegador não consegue gravar vídeo da tela.'); return; }
    if (dashcam.gravando) {
      dashcam.parar();
      clearInterval(relogioRec);
      $('rec').classList.add('hidden');
      $('btnRec').classList.remove('active');
      return;
    }
    dashcam.iniciar();
    $('btnRec').classList.add('active');
    $('rec').classList.remove('hidden');
    const t0 = Date.now();
    relogioRec = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $('recTempo').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 500);
  };

  // ---------- Histórico de viagens ----------
  async function guardarViagem() {
    if (!state.inicio || state.trilha.length < 2) return;
    const duracao = (Date.now() - state.inicio) / 1000;
    try {
      await salvarViagem({
        id: state.inicio, fim: Date.now(), duracao,
        distancia: state.distancia, vmax: state.vmax,
        media: duracao > 0 ? (state.distancia / duracao) * 3.6 : 0,
        demo: state.modo === 'demo',
        pontos: simplificar(state.trilha),
      });
    } catch (_) { /* armazenamento indisponível */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') guardarViagem(); });
  window.addEventListener('pagehide', guardarViagem);

  function mostrarViagem(v) {
    viagemVista = v;
    const dados = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: v ? v.pontos.map((p) => [p[0], p[1]]) : [] } };
    if (map.getSource('viagem')) map.getSource('viagem').setData(dados);
    else if (map.isStyleLoaded()) {
      map.addSource('viagem', { type: 'geojson', data: dados });
      map.addLayer({
        id: 'viagem', type: 'line', source: 'viagem', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ff9f1c', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 18, 10], 'line-opacity': 0.9 },
      });
    }
  }

  async function painelHistorico() {
    await guardarViagem();
    const viagens = await listarViagens().catch(() => []);
    const km = viagens.reduce((a, v) => a + v.distancia, 0) / 1000;
    const horas = viagens.reduce((a, v) => a + v.duracao, 0) / 3600;
    const f = el(`
      <div class="totais"><div><b>${viagens.length}</b>viagens</div><div><b>${km.toFixed(1).replace('.', ',')}</b>km no total</div><div><b>${horas.toFixed(1).replace('.', ',')}</b>horas</div></div>
      ${viagemVista ? '<button class="btn" id="limparVista">Esconder viagem do mapa</button>' : ''}
      <div id="listaViagens"></div>
      <p class="dica">As viagens ficam salvas só neste aparelho.</p>`);
    const lista = f.querySelector('#listaViagens');
    if (!viagens.length) lista.append(el('<p class="dica">Nenhuma viagem ainda. Elas são salvas sozinhas enquanto você dirige.</p>'));
    for (const v of viagens) {
      const dur = Math.round(v.duracao / 60);
      const item = el(`<div class="viagem">
        <div class="titulo">${new Date(v.id).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}${v.demo ? ' · demonstração' : ''}</div>
        <div class="numeros"><div><b>${(v.distancia / 1000).toFixed(1).replace('.', ',')}</b>km</div><div><b>${dur}</b>min</div><div><b>${Math.round(v.media)}</b>média km/h</div><div><b>${Math.round(v.vmax)}</b>máx km/h</div></div>
        <button class="btn" data-a="ver">Ver no mapa</button><button class="btn" data-a="gpx">GPX</button><button class="btn perigo" data-a="apagar">Apagar</button>
      </div>`);
      const nodo = item.firstElementChild;
      nodo.querySelector('[data-a=ver]').onclick = () => {
        mostrarViagem(v);
        setFollow(false);
        const b = new maplibregl.LngLatBounds();
        v.pontos.forEach((p) => b.extend([p[0], p[1]]));
        map.fitBounds(b, { padding: 60, pitch: 45, maxZoom: 17 });
        fecharPainel();
      };
      nodo.querySelector('[data-a=gpx]').onclick = () => baixarArquivo(gpxDaViagem(v), `viagem-${v.id}.gpx`, 'application/gpx+xml');
      nodo.querySelector('[data-a=apagar]').onclick = async () => {
        if (!confirm('Apagar esta viagem? Não dá para desfazer.')) return;
        await apagarViagem(v.id);
        if (viagemVista?.id === v.id) mostrarViagem(null);
        painelHistorico();
      };
      lista.append(item);
    }
    abrirPainel('Histórico de viagens', f);
    $('limparVista')?.addEventListener('click', () => { mostrarViagem(null); painelHistorico(); });
  }
  $('btnHist').onclick = painelHistorico;

  function baixarArquivo(texto, nome, tipo) {
    const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
    const a = Object.assign(document.createElement('a'), { href: url, download: nome });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Satélite de dia, mapa noturno entre 18h e 6h
  const h = new Date().getHours();
  setTema(h >= 18 || h < 6 ? 'noite' : 'satelite');

  // ---------- PWA ----------
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
