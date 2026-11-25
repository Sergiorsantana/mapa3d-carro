/* Ajustes do app, salvos no próprio aparelho (localStorage). */

const CHAVE = 'mapa3d-ajustes-v1';

const PADRAO = {
  // Calibração da câmera
  campoDeVisao: 66,       // graus no lado maior da imagem
  alturaCamera: 1.25,     // metros do chão até o celular
  horizonteManual: 0,     // ajuste fino do horizonte, em % da altura da imagem (- sobe, + desce)
  sensorInclinacao: true, // corrige o horizonte pela inclinação do celular (acelerômetro)
  // IA
  modeloIA: 'rapido',     // 'rapido' (EfficientDet-Lite0) ou 'preciso' (EfficientDet-Lite2)
  economia: true,         // reduz a IA quando parado, com bateria baixa ou celular lento
  // Avisos
  somAviso: true,         // bipe quando muito perto do carro da frente
  vozNavegacao: true,     // instruções faladas da rota
  avisoVelocidade: true,  // alerta ao passar do limite da via
  faixas: true,           // desenha as faixas da rua
};

export const AJUSTES = { ...PADRAO, ...lerSalvos() };

function lerSalvos() {
  try { return JSON.parse(localStorage.getItem(CHAVE)) || {}; } catch (_) { return {}; }
}

const ouvintes = new Set();

export function salvar(mudancas) {
  Object.assign(AJUSTES, mudancas);
  try { localStorage.setItem(CHAVE, JSON.stringify(AJUSTES)); } catch (_) { /* sem armazenamento */ }
  ouvintes.forEach((fn) => fn(mudancas));
}

/** Avisa quando algum ajuste mudar. */
export function aoMudar(fn) { ouvintes.add(fn); }

export function restaurarPadrao() { salvar({ ...PADRAO }); }
