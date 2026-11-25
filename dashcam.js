/* Modo dashcam: grava um vídeo com o mapa 3D, a câmera (com as detecções da IA) e o painel.
 * Tudo é feito no próprio aparelho; o vídeo é baixado ao parar a gravação.
 */

const TIPOS = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export class Dashcam {
  /**
   * @param {maplibregl.Map} map
   * @param {{video: HTMLVideoElement, overlay: HTMLCanvasElement, painel: () => {vel:string, info:string}}} fontes
   */
  constructor(map, fontes) {
    this.map = map;
    this.fontes = fontes;
    this.gravando = false;
    this.desenhar = this.desenhar.bind(this);
  }

  static suportado() {
    return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
  }

  iniciar() {
    const src = this.map.getCanvas();
    // Até 1280 px de largura, mantendo a proporção da tela
    const esc = Math.min(1, 1280 / src.width);
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(src.width * esc / 2) * 2;
    this.canvas.height = Math.round(src.height * esc / 2) * 2;
    this.ctx = this.canvas.getContext('2d');
    const tipo = TIPOS.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    this.tipo = tipo;
    const stream = this.canvas.captureStream(30);
    this.rec = new MediaRecorder(stream, tipo ? { mimeType: tipo, videoBitsPerSecond: 5_000_000 } : undefined);
    this.pedacos = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.pedacos.push(e.data); };
    this.rec.onstop = () => this.baixar();
    this.rec.start(1000);
    this.inicio = Date.now();
    this.gravando = true;
    // Desenha logo depois de cada quadro do mapa (o conteúdo do WebGL ainda está disponível)
    this.map.on('render', this.desenhar);
    this.map.triggerRepaint();
  }

  parar() {
    if (!this.gravando) return;
    this.gravando = false;
    this.map.off('render', this.desenhar);
    this.rec.stop();
  }

  desenhar() {
    const { ctx, canvas: c } = this;
    const W = c.width, H = c.height;
    ctx.drawImage(this.map.getCanvas(), 0, 0, W, H);

    // Câmera no canto superior direito, com as caixas da IA por cima
    const v = this.fontes.video;
    if (v && v.readyState >= 2 && v.videoWidth) {
      const w = Math.round(W * 0.3), h = Math.round((w * v.videoHeight) / v.videoWidth);
      const x = W - w - 12, y = 12;
      ctx.fillStyle = '#000';
      ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
      ctx.drawImage(v, x, y, w, h);
      if (this.fontes.overlay?.width) ctx.drawImage(this.fontes.overlay, x, y, w, h);
    }

    // Painel com velocidade, data e hora
    const p = this.fontes.painel();
    ctx.fillStyle = 'rgba(11,18,32,0.78)';
    ctx.fillRect(12, 12, 230, 74);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.fillText(p.vel, 24, 58);
    const largura = ctx.measureText(p.vel).width;
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText('km/h', 30 + largura, 58);
    ctx.fillText(new Date().toLocaleString('pt-BR'), 24, 78);
    ctx.fillText(p.info, 12, H - 14);

    // Ponto vermelho de gravação
    if (Math.floor(Date.now() / 500) % 2) {
      ctx.fillStyle = '#ff3b30';
      ctx.beginPath(); ctx.arc(W - 22, H - 22, 8, 0, Math.PI * 2); ctx.fill();
    }
  }

  baixar() {
    const ext = this.tipo.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(this.pedacos, { type: this.tipo || 'video/webm' });
    const url = URL.createObjectURL(blob);
    const d = new Date(this.inicio);
    const nome = `viagem-${d.toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`;
    const a = Object.assign(document.createElement('a'), { href: url, download: nome });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    this.pedacos = [];
  }
}
