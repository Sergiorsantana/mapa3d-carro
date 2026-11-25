/* Aviso de distância do veículo da frente (na mesma faixa).
 * Mostra a distância em metros e em segundos, e bipa quando fica perigoso.
 * É só um auxílio: a distância vem de uma única câmera e é aproximada.
 */
import { AJUSTES } from './ajustes.js?v=1';

const VEICULOS = { carro: 2.25, caminhao: 3.5, onibus: 6, moto: 1 }; // metade do comprimento (m)

let audio = null;
/** Precisa ser chamado num toque do usuário (navegadores bloqueiam som automático). */
export function liberarSom() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
  } catch (_) { /* sem áudio */ }
}

export function bipe(freq = 880, dur = 0.14, vezes = 1) {
  if (!audio) return;
  for (let i = 0; i < vezes; i++) {
    const t = audio.currentTime + i * (dur + 0.08);
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(audio.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

export class AvisoDistancia {
  /** @param {HTMLElement} el elemento onde o aviso aparece */
  constructor(el) {
    this.el = el;
    this.nivel = 'ok';
    this.ultimoBipe = 0;
  }

  /**
   * @param {{tipo:string, x:number, z:number, vz?:number}[]} objs objetos detectados (z = centro, m)
   * @param {number} velocidade nossa velocidade em m/s
   */
  atualizar(objs, velocidade) {
    let lider = null;
    for (const o of objs) {
      if (!(o.tipo in VEICULOS) || Math.abs(o.x) > 1.8 || o.z <= 0) continue;
      if (!lider || o.z < lider.z) lider = o;
    }
    if (!lider) { this.mostrar(null); return; }

    const dist = Math.max(0.5, lider.z - VEICULOS[lider.tipo]);   // até a traseira dele
    const tempo = velocidade > 1.5 ? dist / velocidade : Infinity; // segundos até chegar onde ele está
    const aproximando = -(lider.vz ?? 0);                          // m/s, positivo = chegando perto
    const colisao = aproximando > 0.8 ? dist / aproximando : Infinity; // segundos até encostar

    let nivel = 'ok';
    if (colisao < 2.5 || (tempo < 0.8 && velocidade > 5)) nivel = 'perigo';
    else if (colisao < 4.5 || (tempo < 1.5 && velocidade > 5)) nivel = 'atencao';

    this.mostrar({ dist, tempo, nivel });

    const agora = performance.now();
    if (AJUSTES.somAviso) {
      if (nivel === 'perigo' && agora - this.ultimoBipe > 600) { bipe(1200, 0.12, 2); this.ultimoBipe = agora; }
      else if (nivel === 'atencao' && this.nivel === 'ok') { bipe(760, 0.15, 1); this.ultimoBipe = agora; }
    }
    this.nivel = nivel;
  }

  mostrar(info) {
    if (!info) { this.el.classList.add('hidden'); this.nivel = 'ok'; return; }
    this.el.classList.remove('hidden');
    this.el.className = 'aviso ' + info.nivel;
    const seg = Number.isFinite(info.tempo) ? ` · ${info.tempo.toFixed(1).replace('.', ',')} s` : '';
    const rotulo = info.nivel === 'perigo' ? 'FREIE! ' : info.nivel === 'atencao' ? 'Muito perto · ' : '';
    this.el.textContent = `${rotulo}🚗 ${Math.round(info.dist)} m${seg}`;
  }
}
