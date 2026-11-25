/* Inclinação do celular pelo acelerômetro.
 * Serve para saber onde fica o horizonte na imagem da câmera: se o celular está um pouco
 * apontado para baixo ou para cima, o horizonte sobe ou desce, e a distância dos carros muda.
 */

export const INCLINACAO = {
  elevacao: 0,   // ângulo da câmera traseira acima (+) ou abaixo (-) do horizonte, em radianos
  disponivel: false,
};

const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

function aoMovimento(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  // No Android o vetor aponta "para cima"; no iOS, para baixo.
  const s = iOS ? -1 : 1;
  const x = a.x * s, y = a.y * s, z = a.z * s;
  const n = Math.hypot(x, y, z);
  if (n < 5) return; // leitura estranha (carro freando forte etc.)
  // A câmera traseira olha para -z do aparelho; elevação = ângulo entre -z e o plano horizontal.
  const elev = Math.asin(Math.max(-1, Math.min(1, -z / n)));
  // Filtro passa-baixa: ignora trepidação da rua
  INCLINACAO.elevacao = INCLINACAO.disponivel ? INCLINACAO.elevacao * 0.95 + elev * 0.05 : elev;
  INCLINACAO.disponivel = true;
}

/** Precisa ser chamado num toque do usuário (exigência do iPhone). */
export async function iniciarSensores() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') return false;
    }
    window.addEventListener('devicemotion', aoMovimento);
    return true;
  } catch (_) {
    return false;
  }
}
