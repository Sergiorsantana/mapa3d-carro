/* Percepção por câmera: detecta veículos, pessoas e semáforos com IA no próprio celular
 * (MediaPipe Object Detector / EfficientDet, roda no navegador, nada é enviado para servidor)
 * e estima onde cada um está em metros em relação ao carro.
 * A calibração (campo de visão, altura, horizonte) fica em ajustes.js e no painel ⚙ do app.
 */
import { AJUSTES } from './ajustes.js?v=1';
import { INCLINACAO } from './sensores.js?v=1';

const VERSAO = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSAO}`;
// Dois modelos (licença Apache 2.0): Lite0 é leve e rápido; Lite2 erra menos (motos, bikes, objetos longe).
const MODELOS = {
  rapido: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
  preciso: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite',
};
// Intervalo entre detecções (ms) em cada situação
const INTERVALO = { normal: 70, preciso: 110, lento: 160, bateria: 250, parado: 450 };

// Classe do modelo -> tipo na cena + tamanho real aproximado (altura e comprimento em metros)
const TIPOS = {
  car:            { tipo: 'carro',    h: 1.5, l: 4.5, chao: true },
  truck:          { tipo: 'caminhao', h: 3.0, l: 7.0, chao: true },
  bus:            { tipo: 'onibus',   h: 3.1, l: 12,  chao: true },
  motorcycle:     { tipo: 'moto',     h: 1.5, l: 2.0, chao: true },
  bicycle:        { tipo: 'bike',     h: 1.6, l: 1.8, chao: true },
  person:         { tipo: 'pessoa',   h: 1.7, l: 0.5, chao: true },
  'traffic light':{ tipo: 'semaforo', h: 1.0, l: 0.4, chao: false },
};
const NOMES = { carro: 'Carro', caminhao: 'Caminhão', onibus: 'Ônibus', moto: 'Moto', bike: 'Bike', pessoa: 'Pessoa', semaforo: 'Semáforo' };

// Mistura duas cores 0xRRGGBB (suaviza a cor lida quadro a quadro)
function misturar(a, b, t) {
  const ca = [(a >> 16) & 255, (a >> 8) & 255, a & 255];
  const cb = [(b >> 16) & 255, (b >> 8) & 255, b & 255];
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return (c[0] << 16) | (c[1] << 8) | c[2];
}

async function criarDetector(nome) {
  const vision = await import(`${CDN}/vision_bundle.mjs`);
  const arquivos = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  const opcoes = (delegate) => ({
    baseOptions: { modelAssetPath: MODELOS[nome] || MODELOS.rapido, delegate },
    runningMode: 'VIDEO',
    scoreThreshold: 0.35,
    maxResults: 30,
    categoryAllowlist: Object.keys(TIPOS),
  });
  try {
    return await vision.ObjectDetector.createFromOptions(arquivos, opcoes('GPU'));
  } catch (_) {
    return await vision.ObjectDetector.createFromOptions(arquivos, opcoes('CPU'));
  }
}

export class PercepcaoIA {
  /** @param {{video: HTMLVideoElement, overlay: HTMLCanvasElement, onStatus?: (msg: string) => void}} o */
  constructor({ video, overlay, onStatus }) {
    this.video = video;
    this.overlay = overlay;
    this.onStatus = onStatus || (() => {});
    this.trilhas = [];
    this.proximoId = 1;
    this.ultimo = 0;
    this.fps = 0;
    this.amostra = document.createElement('canvas');
    this.amostra.width = 8; this.amostra.height = 18;
    this.loop = this.loop.bind(this);
    this.velocidade = 0;        // m/s do nosso carro (o app atualiza)
    this.tempoDeteccao = 30;    // média de ms gastos por detecção
    this.modo = 'normal';       // modo de economia atual (mostrado no painel)
    this.bateria = null;
    navigator.getBattery?.().then((b) => { this.bateria = b; }).catch(() => {});
  }

  /** Decide de quanto em quanto tempo rodar a IA (economia de bateria e aquecimento). */
  intervalo() {
    let modo = AJUSTES.modeloIA === 'preciso' ? 'preciso' : 'normal';
    if (AJUSTES.economia) {
      if (this.tempoDeteccao > 90) modo = 'lento';                       // celular não está dando conta / esquentando
      if (this.bateria && !this.bateria.charging && this.bateria.level < 0.2) modo = 'bateria';
      if (this.velocidade < 1) modo = 'parado';
    }
    this.modo = modo;
    return INTERVALO[modo];
  }

  /** Troca entre o modelo rápido e o preciso sem parar a câmera. */
  async trocarModelo(nome) {
    if (!this.detector) return;
    this.onStatus('Carregando IA…');
    const novo = await criarDetector(nome);
    const antigo = this.detector;
    this.detector = novo;
    antigo.close?.();
    this.onStatus('IA ativa');
  }

  /** Linha do horizonte na imagem (px), pela inclinação do celular + ajuste manual. */
  horizonte(H, f) {
    let y = H / 2;
    if (AJUSTES.sensorInclinacao && INCLINACAO.disponivel) y += f * Math.tan(INCLINACAO.elevacao);
    return y + (AJUSTES.horizonteManual / 100) * H;
  }

  async iniciar() {
    this.onStatus('Abrindo câmera…');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = stream;
    await this.video.play();
    this.onStatus('Carregando IA…');
    this.detector = await criarDetector(AJUSTES.modeloIA);
    this.onStatus('IA ativa');
    this.ativo = true;
    requestAnimationFrame(this.loop);
  }

  loop(agora) {
    if (!this.ativo) return;
    if (agora - this.ultimo >= this.intervalo() && this.video.readyState >= 2) {
      const dt = agora - this.ultimo;
      this.ultimo = agora;
      const t0 = performance.now();
      const r = this.detector.detectForVideo(this.video, agora);
      this.tempoDeteccao = this.tempoDeteccao * 0.9 + (performance.now() - t0) * 0.1;
      this.fps = this.fps * 0.9 + (1000 / dt) * 0.1;
      const medidas = this.medir(r.detections);
      this.rastrear(medidas, agora);
      this.desenhar(medidas);
    }
    requestAnimationFrame(this.loop);
  }

  /** Converte cada caixa da imagem em posição no chão: x (direita) e z (frente), em metros. */
  medir(deteccoes) {
    const W = this.video.videoWidth, H = this.video.videoHeight;
    const f = (Math.max(W, H) / 2) / Math.tan((AJUSTES.campoDeVisao * Math.PI) / 360); // distância focal em pixels
    const cx = W / 2;
    const cy = this.horizonte(H, f); // linha do horizonte (corrigida pela inclinação e calibração)
    this.horizonteY = cy;
    const out = [];
    for (const d of deteccoes) {
      const cat = d.categories[0];
      const info = TIPOS[cat.categoryName];
      if (!info) continue;
      const b = d.boundingBox;
      const base = b.originY + b.height;
      const cortado = b.originY < 3 || base > H - 3;

      // 1) Pelo tamanho: objeto de altura conhecida
      const zTam = cortado ? null : (f * info.h) / b.height;
      // 2) Pelo chão: quanto mais abaixo do horizonte, mais perto
      const zChao = info.chao && base - cy > 6 && base < H - 3 ? (f * AJUSTES.alturaCamera) / (base - cy) : null;
      let z = zTam && zChao ? (zTam + zChao) / 2 : zTam || zChao;
      if (!z) continue;
      z = Math.min(Math.max(z, 2), 120);
      const x = ((b.originX + b.width / 2 - cx) * z) / f;

      const m = { tipo: info.tipo, x, z: z + info.l / 2, caixa: b, score: cat.score, dist: z };
      if (info.tipo === 'semaforo') m.cor = this.corSemaforo(b);
      else if (info.tipo !== 'pessoa') m.pintura = this.corVeiculo(b);
      out.push(m);
    }
    return out;
  }

  /** Olha os pixels dentro do semáforo e decide se está vermelho, amarelo ou verde. */
  corSemaforo(b) {
    const ctx = this.amostra.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, b.originX, b.originY, b.width, b.height, 0, 0, 8, 18);
    const px = ctx.getImageData(0, 0, 8, 18).data;
    const cont = { vermelho: 0, amarelo: 0, verde: 0 };
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, g = px[i + 1] / 255, bl = px[i + 2] / 255;
      const max = Math.max(r, g, bl), min = Math.min(r, g, bl);
      if (max < 0.55 || max - min < 0.25) continue; // apagado ou sem cor
      let h;
      if (max === r) h = (60 * ((g - bl) / (max - min)) + 360) % 360;
      else if (max === g) h = 60 * ((bl - r) / (max - min)) + 120;
      else h = 60 * ((r - g) / (max - min)) + 240;
      if (h < 20 || h > 330) cont.vermelho++;
      else if (h < 65) cont.amarelo++;
      else if (h > 100 && h < 200) cont.verde++;
    }
    const melhor = Object.entries(cont).sort((a, b) => b[1] - a[1])[0];
    return melhor[1] >= 2 ? melhor[0] : null;
  }

  /** Lê a cor da lataria: média dos pixels da parte de baixo da caixa (abaixo dos vidros). */
  corVeiculo(b) {
    const ctx = this.amostra.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, b.originX + b.width * 0.2, b.originY + b.height * 0.45, b.width * 0.6, b.height * 0.35, 0, 0, 8, 18);
    const px = ctx.getImageData(0, 0, 8, 18).data;
    let r = 0, g = 0, bl = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; bl += px[i + 2]; n++; }
    r /= n; g /= n; bl /= n;
    // Realça a saturação, porque a câmera tende a deixar as cores "lavadas"
    const media = (r + g + bl) / 3;
    const sat = 1.35;
    const c = (v) => Math.max(0, Math.min(255, Math.round(media + (v - media) * sat)));
    return (c(r) << 16) | (c(g) << 8) | c(bl);
  }

  /** Associa detecções entre quadros para os objetos não piscarem. */
  rastrear(medidas, agora) {
    const livres = new Set(this.trilhas);
    for (const m of medidas) {
      let melhor = null, menor = Infinity;
      for (const t of livres) {
        if (t.tipo !== m.tipo) continue;
        const d = Math.hypot(t.x - m.x, t.z - m.z);
        if (d < Math.max(3, m.z * 0.25) && d < menor) { menor = d; melhor = t; }
      }
      if (melhor) {
        livres.delete(melhor);
        const zAntes = melhor.z;
        melhor.x += (m.x - melhor.x) * 0.4;
        melhor.z += (m.z - melhor.z) * 0.4;
        // velocidade relativa (m/s): negativa = está se aproximando
        const dts = (agora - melhor.visto) / 1000;
        if (dts > 0) melhor.vz = (melhor.vz ?? 0) * 0.7 + ((melhor.z - zAntes) / dts) * 0.3;
        melhor.cor = m.cor ?? melhor.cor;
        if (m.pintura != null) melhor.pintura = misturar(melhor.pintura ?? m.pintura, m.pintura, 0.3);
        melhor.visto = agora;
        melhor.vezes++;
      } else {
        this.trilhas.push({ id: 'ia' + this.proximoId++, tipo: m.tipo, x: m.x, z: m.z, cor: m.cor, pintura: m.pintura, visto: agora, vezes: 1 });
      }
    }
    this.trilhas = this.trilhas.filter((t) => agora - t.visto < 800);
  }

  desenhar(medidas) {
    const c = this.overlay;
    if (c.offsetParent === null) return; // escondido
    const W = this.video.videoWidth, H = this.video.videoHeight;
    if (c.width !== W) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = Math.max(2, W / 320);
    ctx.font = `bold ${Math.round(W / 40)}px system-ui, sans-serif`;
    // Linha do horizonte: deve coincidir com o fim da rua lá longe (use o ⚙ para calibrar)
    if (this.horizonteY != null) {
      ctx.save();
      ctx.setLineDash([W / 60, W / 90]);
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.85)';
      ctx.beginPath(); ctx.moveTo(0, this.horizonteY); ctx.lineTo(W, this.horizonteY); ctx.stroke();
      ctx.restore();
    }
    for (const m of medidas) {
      const b = m.caixa;
      const cor = m.tipo === 'pessoa' || m.tipo === 'bike' || m.tipo === 'moto' ? '#ffb020' : m.tipo === 'semaforo' ? '#34d17a' : '#5aa0ff';
      ctx.strokeStyle = cor;
      ctx.strokeRect(b.originX, b.originY, b.width, b.height);
      const txt = `${NOMES[m.tipo]} ${Math.round(m.dist)} m`;
      const tw = ctx.measureText(txt).width + 10;
      ctx.fillStyle = cor;
      ctx.fillRect(b.originX, b.originY - W / 32, tw, W / 32);
      ctx.fillStyle = '#0b1220';
      ctx.fillText(txt, b.originX + 5, b.originY - W / 120);
      if (m.pintura != null) { // amostra da cor lida
        ctx.fillStyle = '#' + m.pintura.toString(16).padStart(6, '0');
        ctx.fillRect(b.originX + tw + 4, b.originY - W / 32, W / 32, W / 32);
      }
    }
  }

  /** Objetos estáveis (vistos pelo menos 2 vezes), prontos para a cena 3D. */
  objetos() {
    return this.trilhas.filter((t) => t.vezes >= 2);
  }

  parar() {
    this.ativo = false;
    this.video.srcObject?.getTracks().forEach((t) => t.stop());
  }
}

/** Trânsito de mentira para o modo demonstração (sem câmera). */
export class TrafegoSimulado {
  constructor() {
    this.lista = [];
    this.velocidade = 12; // m/s do nosso carro (atualizado pelo app)
    let id = 0;
    const add = (tipo, x, z, vRel = 0, extra = {}) => this.lista.push({ id: 'sim' + id++, tipo, x, z, vRel, ...extra });
    // Faixas: esquerda (-3.5), a nossa (0), direita (3.5). Calçadas em ±8.
    add('carro', 0, 30, 0.4);
    add('carro', -3.5, 6, 1.5);
    add('carro', -3.5, 26, -0.8);
    add('onibus', 3.5, 22, -0.5);
    add('carro', 3.5, -9, 1.2);
    add('carro', 0, -12, 0.3);
    add('caminhao', -3.5, 48, -0.3);
    add('carro', 0, 52, -0.2);
    add('moto', -2.2, 4, 2.5);
    add('bike', 6, 18, null);
    for (let i = 0; i < 7; i++) add('pessoa', (i % 2 ? 1 : -1) * (8 + Math.random()), 6 + i * 11, null);
    add('semaforo', 6.5, 70, null, { cor: 'verde' });
    this.t = performance.now();
  }

  atualizar() {
    const agora = performance.now();
    const dt = Math.min((agora - this.t) / 1000, 0.2);
    this.t = agora;
    for (const o of this.lista) {
      // vRel = velocidade em relação ao nosso carro; null = parado/devagar no mundo
      const v = o.vRel != null ? o.vRel + Math.sin(agora / 3000 + o.z) * 0.3 : o.tipo === 'bike' ? 4 - this.velocidade : (o.tipo === 'pessoa' ? 1.2 : 0) - this.velocidade;
      o.z += v * dt;
      o.vz = v;
      if (o.z < -25) o.z = 60 + Math.random() * 40;
      if (o.z > 100) o.z = -20;
      if (o.tipo === 'semaforo') {
        const ciclo = (agora / 1000) % 20;
        o.cor = ciclo < 11 ? 'verde' : ciclo < 14 ? 'amarelo' : 'vermelho';
      }
    }
  }

  objetos() {
    this.atualizar();
    return this.lista;
  }
}

export { NOMES };
