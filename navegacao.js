/* Navegação: busca de endereço (Nominatim/OpenStreetMap), rota (OSRM) desenhada no mapa,
 * instruções curva a curva e voz em português.
 * Serviços públicos e gratuitos: o texto buscado e a sua posição são enviados a eles só quando
 * você procura um destino ou a rota precisa ser recalculada.
 */
import { AJUSTES } from './ajustes.js?v=1';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';

const SETA = {
  left: '⬅', right: '➡', 'slight left': '⬉', 'slight right': '⬈',
  'sharp left': '↰', 'sharp right': '↱', straight: '⬆', uturn: '⤸',
};
const ACAO = {
  left: 'vire à esquerda', right: 'vire à direita',
  'slight left': 'mantenha-se à esquerda', 'slight right': 'mantenha-se à direita',
  'sharp left': 'vire acentuadamente à esquerda', 'sharp right': 'vire acentuadamente à direita',
  straight: 'siga em frente', uturn: 'faça o retorno',
};

function distM(a, b) {
  const k = Math.cos((a[1] * Math.PI) / 180) * 111320;
  return Math.hypot((a[0] - b[0]) * k, (a[1] - b[1]) * 110540);
}

export function textoManobra(step) {
  const m = step.maneuver;
  const via = step.name ? ` na ${step.name}` : '';
  switch (m.type) {
    case 'depart': return `Siga${step.name ? ' pela ' + step.name : ''}`;
    case 'arrive': return 'Você chegou ao destino';
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn':
      return `Na rotatória, pegue a ${m.exit || 1}ª saída${via}`;
    case 'merge': return `Entre${via}`;
    case 'on ramp': return `Pegue o acesso${via}`;
    case 'off ramp': return `Pegue a saída${via}`;
    case 'fork': return `Na bifurcação, ${ACAO[m.modifier] || 'siga'}${via}`;
    case 'continue':
    case 'new name':
      return m.modifier && m.modifier !== 'straight' ? `${cap(ACAO[m.modifier])}${via}` : `Continue${via}`;
    default: return `${cap(ACAO[m.modifier] || 'siga')}${via}`;
  }
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function setaManobra(step) {
  const m = step.maneuver;
  if (m.type === 'arrive') return '🏁';
  if (m.type.startsWith('roundabout') || m.type === 'rotary') return '⟳';
  return SETA[m.modifier] || '⬆';
}

function falar(texto) {
  if (!AJUSTES.vozNavegacao || !('speechSynthesis' in window)) return;
  // "300 m" -> "300 metros", "1,2 km" -> "1,2 quilômetros" (a voz lê melhor)
  texto = texto.replace(/(\d) m\b/g, '$1 metros').replace(/(\d) km\b/g, '$1 quilômetros');
  const u = new SpeechSynthesisUtterance(texto);
  u.lang = 'pt-BR';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function fmtDist(m) {
  if (m >= 1000) return (m / 1000).toFixed(1).replace('.', ',') + ' km';
  return (m > 100 ? Math.round(m / 10) * 10 : Math.round(m)) + ' m';
}

export class Navegacao {
  /**
   * @param {maplibregl.Map} map
   * @param {{banner: HTMLElement, onMudou?: () => void}} ui
   */
  constructor(map, ui) {
    this.map = map;
    this.ui = ui;
    this.rota = null;      // { coords, steps, distancia, duracao, destino }
    this.passo = 0;
    this.foraDaRota = 0;
    this.recalculando = false;
    this.ultimoRecalculo = 0;
    this.falado = {};
  }

  async buscar(texto, perto) {
    const p = new URLSearchParams({ q: texto, format: 'jsonv2', limit: '6', 'accept-language': 'pt-BR', addressdetails: '0' });
    if (perto) {
      const [lng, lat] = perto;
      p.set('viewbox', `${lng - 0.4},${lat + 0.4},${lng + 0.4},${lat - 0.4}`); // dá preferência a lugares perto
    }
    const r = await fetch(`${NOMINATIM}?${p}`);
    if (!r.ok) throw new Error('Busca indisponível');
    const lista = await r.json();
    return lista.map((x) => ({ nome: x.display_name, lng: +x.lon, lat: +x.lat }));
  }

  async iniciar(origem, destino) {
    const url = `${OSRM}/${origem[0]},${origem[1]};${destino.lng},${destino.lat}?overview=full&geometries=geojson&steps=true`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Rota indisponível');
    const d = await r.json();
    if (d.code !== 'Ok' || !d.routes?.length) throw new Error('Não encontrei rota até esse destino');
    const rt = d.routes[0];
    this.rota = {
      coords: rt.geometry.coordinates,
      steps: rt.legs[0].steps,
      distancia: rt.distance,
      duracao: rt.duration,
      destino,
    };
    this.passo = 1; // o passo 0 é a saída
    this.foraDaRota = 0;
    this.falado = {};
    this.desenhar();
    if (this.rota.steps[1]) falar(`Rota calculada. ${fmtDist(this.rota.steps[0].distance)}, depois ${textoManobra(this.rota.steps[1]).toLowerCase()}`);
    this.atualizarBanner(origem);
    this.ui.onMudou?.();
    return this.rota;
  }

  encerrar() {
    this.rota = null;
    this.desenhar();
    this.ui.banner.classList.add('hidden');
    this.ui.onMudou?.();
  }

  /** Recoloca a linha da rota no mapa (também depois de trocar o visual). */
  desenhar() {
    const map = this.map;
    const dados = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: this.rota?.coords || [] } };
    if (map.getSource('rota')) { map.getSource('rota').setData(dados); return; }
    if (!map.isStyleLoaded()) return;
    map.addSource('rota', { type: 'geojson', data: dados });
    const antes = map.getLayer('trilha-borda') ? 'trilha-borda' : undefined;
    map.addLayer({
      id: 'rota-borda', type: 'line', source: 'rota',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#004d66', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 18, 22], 'line-opacity': 0.7 },
    }, antes);
    map.addLayer({
      id: 'rota', type: 'line', source: 'rota',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#00e5ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 18, 14], 'line-opacity': 0.85 },
    }, antes);
  }

  /** Chamado a cada posição do GPS. */
  atualizar(pos) {
    if (!this.rota) return;
    // Distância até a rota (vértice mais próximo é suficiente com geometria "full")
    let menor = Infinity;
    for (const c of this.rota.coords) menor = Math.min(menor, distM(pos, c));
    this.foraDaRota = menor > 50 ? this.foraDaRota + 1 : 0;
    if (this.foraDaRota >= 3 && !this.recalculando && Date.now() - this.ultimoRecalculo > 15000) {
      this.recalcular(pos);
      return;
    }
    // Avança para a próxima manobra quando passar por ela
    const steps = this.rota.steps;
    while (this.passo < steps.length - 1 && distM(pos, steps[this.passo].maneuver.location) < 20) this.passo++;
    this.atualizarBanner(pos);
  }

  async recalcular(pos) {
    this.recalculando = true;
    this.ultimoRecalculo = Date.now();
    falar('Recalculando rota');
    try { await this.iniciar(pos, this.rota.destino); } catch (_) { /* tenta de novo depois */ }
    this.recalculando = false;
  }

  atualizarBanner(pos) {
    const step = this.rota.steps[this.passo];
    if (!step) return;
    const d = distM(pos, step.maneuver.location);
    const b = this.ui.banner;
    b.classList.remove('hidden');
    b.querySelector('.seta').textContent = setaManobra(step);
    b.querySelector('.dist').textContent = fmtDist(d);
    b.querySelector('.texto').textContent = textoManobra(step);
    // Restante: daqui até a manobra + passos seguintes
    let resto = d;
    for (let i = this.passo; i < this.rota.steps.length; i++) resto += i === this.passo ? 0 : this.rota.steps[i].distance;
    const min = Math.max(1, Math.round((resto / this.rota.distancia) * this.rota.duracao / 60));
    b.querySelector('.resto').textContent = `${fmtDist(resto)} · ${min} min`;

    // Voz: aviso antecipado e na hora
    const chave = this.passo;
    if (step.maneuver.type === 'arrive') {
      if (d < 30 && !this.falado[chave + 'f']) { this.falado[chave + 'f'] = 1; falar('Você chegou ao destino'); }
      return;
    }
    if (d < 300 && d > 120 && !this.falado[chave + 'a']) {
      this.falado[chave + 'a'] = 1;
      falar(`Em ${fmtDist(d)}, ${textoManobra(step).toLowerCase()}`);
    } else if (d < 45 && !this.falado[chave + 'f']) {
      this.falado[chave + 'f'] = 1;
      falar(textoManobra(step));
    }
  }
}
