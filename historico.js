/* Histórico de viagens salvo no próprio aparelho (IndexedDB). Nada vai para a internet. */

const BANCO = 'mapa3d';
const LOJA = 'viagens';

function abrir() {
  return new Promise((ok, erro) => {
    const r = indexedDB.open(BANCO, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(LOJA, { keyPath: 'id' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
}

async function transacao(modo, fn) {
  const db = await abrir();
  return new Promise((ok, erro) => {
    const tx = db.transaction(LOJA, modo);
    const resultado = fn(tx.objectStore(LOJA));
    tx.oncomplete = () => ok(resultado?.result ?? resultado);
    tx.onerror = () => erro(tx.error);
  });
}

/** Reduz os pontos: guarda um a cada ~10 m (no máximo 5000). */
export function simplificar(trilha) {
  const out = [];
  let ult = null;
  for (const p of trilha) {
    if (!ult || Math.hypot((p[0] - ult[0]) * 102000, (p[1] - ult[1]) * 110540) > 10) { out.push([+p[0].toFixed(6), +p[1].toFixed(6), p[3]]); ult = p; }
  }
  return out.length > 5000 ? out.filter((_, i) => i % Math.ceil(out.length / 5000) === 0) : out;
}

export const salvarViagem = (v) => transacao('readwrite', (s) => s.put(v));
export const apagarViagem = (id) => transacao('readwrite', (s) => s.delete(id));
export async function listarViagens() {
  const todas = await transacao('readonly', (s) => s.getAll());
  return (todas || []).sort((a, b) => b.id - a.id);
}

export function gpxDaViagem(v) {
  const pts = v.pontos.map(([lng, lat, time]) => `      <trkpt lat="${lat}" lon="${lng}">${time ? `<time>${time}</time>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mapa 3D no Carro" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Viagem ${new Date(v.id).toLocaleString('pt-BR')}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>`;
}
