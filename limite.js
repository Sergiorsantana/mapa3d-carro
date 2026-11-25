/* Limite de velocidade da via.
 * 1) Dado real do OpenStreetMap (tag maxspeed), via Overpass API — servidores públicos e gratuitos,
 *    que às vezes ficam sobrecarregados; por isso há revezamento, nova tentativa espaçada e cache.
 * 2) Sem dado: estimativa pelo tipo de via, seguindo o CTB (só informativa, não dispara alerta).
 */

const SERVIDORES = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
// CTB, art. 61 (vias urbanas): trânsito rápido 80, arterial 60, coletora 40, local 30
const ESTIMATIVA = { motorway: 80, trunk: 80, primary: 60, secondary: 60, tertiary: 40, minor: 30, service: 20 };

const CHAVE_CACHE = 'mapa3d-limites-v1';
let cache = {};
try { cache = JSON.parse(localStorage.getItem(CHAVE_CACHE)) || {}; } catch (_) { cache = {}; }
function guardarCache() {
  const chaves = Object.keys(cache);
  if (chaves.length > 3000) chaves.slice(0, chaves.length - 3000).forEach((k) => delete cache[k]);
  try { localStorage.setItem(CHAVE_CACHE, JSON.stringify(cache)); } catch (_) { /* cheio */ }
}
// Grade de ~110 m para reaproveitar consultas
const celula = (lat, lng) => `${lat.toFixed(3)},${lng.toFixed(3)}`;

function lerMaxspeed(v) {
  if (!v) return null;
  const n = parseFloat(v);
  if (Number.isNaN(n)) return null;
  return /mph/.test(v) ? Math.round(n * 1.609) : n;
}

function distM(a, b) {
  const k = Math.cos((a[1] * Math.PI) / 180) * 111320;
  return Math.hypot((a[0] - b[0]) * k, (a[1] - b[1]) * 110540);
}

export class LimiteVelocidade {
  constructor() {
    this.servidor = 0;
    this.espera = 0;          // até quando não consultar (backoff)
    this.falhas = 0;
    this.consultando = false;
    this.ultimaConsulta = null;
    this.limite = null;       // { kmh, estimado:boolean, via }
  }

  /** Chamado a cada posição nova. `classe` = tipo da via sob o carro (do mapa), para estimar. */
  async atualizar(lng, lat, classe) {
    const c = celula(lat, lng);
    if (cache[c] !== undefined) {
      this.limite = cache[c] ? { kmh: cache[c], estimado: false } : this.estimar(classe);
      return this.limite;
    }
    if (!this.limite || this.limite.estimado) this.limite = this.estimar(classe);

    const agora = Date.now();
    const longe = !this.ultimaConsulta || distM(this.ultimaConsulta, [lng, lat]) > 120;
    if (this.consultando || agora < this.espera || !longe) return this.limite;

    this.consultando = true;
    this.ultimaConsulta = [lng, lat];
    try {
      const q = `[out:json][timeout:8];way(around:30,${lat},${lng})[highway][maxspeed];out tags center 6;`;
      const url = SERVIDORES[this.servidor] + '?data=' + encodeURIComponent(q);
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const dados = await r.json();
      let melhor = null, menor = Infinity;
      for (const e of dados.elements || []) {
        const kmh = lerMaxspeed(e.tags?.maxspeed);
        if (!kmh || !e.center) continue;
        const d = distM([e.center.lon, e.center.lat], [lng, lat]);
        if (d < menor) { menor = d; melhor = kmh; }
      }
      cache[c] = melhor || 0; // 0 = consultado, sem dado
      guardarCache();
      this.falhas = 0;
      this.limite = melhor ? { kmh: melhor, estimado: false } : this.estimar(classe);
    } catch (_) {
      // Servidor ocupado: troca de servidor e espera cada vez mais (10 s, 20 s, 40 s… até 5 min)
      this.falhas++;
      this.servidor = (this.servidor + 1) % SERVIDORES.length;
      this.espera = agora + Math.min(300000, 10000 * 2 ** (this.falhas - 1));
      this.ultimaConsulta = null;
    } finally {
      this.consultando = false;
    }
    return this.limite;
  }

  estimar(classe) {
    const kmh = ESTIMATIVA[classe];
    return kmh ? { kmh, estimado: true } : null;
  }
}

/** Tipo da via mais próxima do carro, lido dos dados do próprio mapa (sem internet extra). */
export function classeDaVia(map, src, lng, lat) {
  if (!src) return null;
  let feats;
  try { feats = map.querySourceFeatures(src, { sourceLayer: 'transportation' }); } catch (_) { return null; }
  const p = [lng, lat];
  let melhor = null, menor = 25; // metros
  for (const f of feats) {
    const cls = f.properties.class;
    if (!(cls in ESTIMATIVA)) continue;
    const linhas = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
    for (const l of linhas) {
      for (let i = 1; i < l.length; i++) {
        const d = distSegmento(p, l[i - 1], l[i]);
        if (d < menor) { menor = d; melhor = cls; }
      }
    }
  }
  return melhor;
}

function distSegmento(p, a, b) {
  const k = Math.cos((p[1] * Math.PI) / 180) * 111320;
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * 110540;
  const bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * 110540;
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
