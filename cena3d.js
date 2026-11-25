/* Cena 3D (Three.js) desenhada dentro do mapa MapLibre.
 * Mostra o seu carro e os objetos que a IA detectou (carros, pessoas, bikes, semáforos)
 * na posição estimada, no estilo "Reality View".
 *
 * Sistema de coordenadas da cena (em metros):
 *   x = leste, y = para cima, z = sul.  O grupo "ego" gira com o rumo do carro,
 *   então dentro dele: x = direita do carro, z negativo = para frente.
 */
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

// ---------- Materiais e geometrias compartilhados ----------
const M = {
  carro: new THREE.MeshLambertMaterial({ color: 0xd7dde6 }),
  pele: new THREE.MeshLambertMaterial({ color: 0xe0b48c }),
  vidro: new THREE.MeshLambertMaterial({ color: 0x1b2433 }),
  roda: new THREE.MeshLambertMaterial({ color: 0x15181d }),
  caminhao: new THREE.MeshLambertMaterial({ color: 0xc4ccd6 }),
  onibus: new THREE.MeshLambertMaterial({ color: 0xe8ecf2 }),
  pessoa: new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x333333 }),
  bike: new THREE.MeshLambertMaterial({ color: 0xffb020, emissive: 0x402800 }),
  ego: new THREE.MeshLambertMaterial({ color: 0xf4f6fa, emissive: 0x1a1d22 }),
  poste: new THREE.MeshLambertMaterial({ color: 0x4a5160 }),
  caixa: new THREE.MeshLambertMaterial({ color: 0x20242c }),
  luzOff: new THREE.MeshLambertMaterial({ color: 0x2a2e36 }),
  luz: {
    vermelho: new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
    amarelo: new THREE.MeshBasicMaterial({ color: 0xffcc00 }),
    verde: new THREE.MeshBasicMaterial({ color: 0x34d17a }),
  },
};
// Cores de carros como as das ruas (branco, prata, preto, vermelho, azul…)
const CORES_CARRO = [0xf4f4f4, 0xb9c0c9, 0x26292f, 0xd62828, 0x1f5fbf, 0x6b7280, 0xf4c430, 0x2a9d8f, 0xf77f00, 0x8e1b3a];
const CORES_ONIBUS = [0x1f8a4c, 0xd62828, 0x1f5fbf, 0xf4c430, 0x7b2cbf];
const CORES_ROUPA = [0xff006e, 0x3a86ff, 0xffbe0b, 0x06d6a0, 0xfb5607, 0x8338ec, 0xffffff];

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}
const escolher = (lista, id) => lista[hash(id) % lista.length];
const pintura = (cor) => new THREE.MeshLambertMaterial({ color: cor });

const G = {
  caixa: new THREE.BoxGeometry(1, 1, 1),
  roda: new THREE.CylinderGeometry(0.34, 0.34, 0.24, 14).rotateZ(Math.PI / 2),
  rodaFina: new THREE.TorusGeometry(0.33, 0.04, 6, 16).rotateY(Math.PI / 2),
  cilindro: new THREE.CylinderGeometry(1, 1, 1, 12),
  esfera: new THREE.SphereGeometry(1, 14, 10),
};

function caixa(mat, w, h, l, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(G.caixa, mat);
  m.scale.set(w, h, l);
  m.position.set(x, y, z);
  return m;
}

// Carro baixo-poligonal com comprimento no eixo z (frente = -z).
function modeloCarro(matCorpo, w = 1.85, l = 4.5) {
  const g = new THREE.Group();
  g.add(caixa(matCorpo, w, 0.62, l, 0, 0.62, 0));                        // corpo
  g.add(caixa(matCorpo, w * 0.86, 0.5, l * 0.5, 0, 1.18, l * 0.05));      // cabine
  g.add(caixa(M.vidro, w * 0.88, 0.36, l * 0.46, 0, 1.18, l * 0.05));     // vidros
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const r = new THREE.Mesh(G.roda, M.roda);
    r.position.set(sx * (w / 2 - 0.08), 0.34, sz * l * 0.32);
    g.add(r);
  }
  g.userData.pintura = matCorpo;
  return g;
}

function modeloCaminhao(cor) {
  const g = new THREE.Group();
  const cabine = pintura(cor);
  g.add(caixa(cabine, 2.45, 2.3, 2.2, 0, 1.55, -2.9));       // cabine colorida
  g.add(caixa(M.vidro, 2.5, 0.8, 1.0, 0, 2.0, -3.6));        // para-brisa
  g.add(caixa(M.caminhao, 2.5, 3.0, 5.6, 0, 1.95, 1.0));     // baú
  g.userData.pintura = cabine;
  for (const z of [-2.9, 0.4, 2.6]) for (const sx of [-1, 1]) {
    const r = new THREE.Mesh(G.roda, M.roda);
    r.scale.set(1.35, 1.35, 1.35);
    r.position.set(sx * 1.15, 0.46, z);
    g.add(r);
  }
  return g;
}

function modeloOnibus(cor) {
  const g = new THREE.Group();
  const corpo = pintura(cor);
  g.add(caixa(corpo, 2.55, 2.6, 12, 0, 1.75, 0));
  g.add(caixa(M.onibus, 2.57, 0.35, 12.02, 0, 3.0, 0));      // teto claro
  g.add(caixa(M.vidro, 2.6, 0.9, 11.2, 0, 2.1, 0));
  g.userData.pintura = corpo;
  for (const z of [-4, 4]) for (const sx of [-1, 1]) {
    const r = new THREE.Mesh(G.roda, M.roda);
    r.scale.set(1.4, 1.4, 1.4);
    r.position.set(sx * 1.2, 0.48, z);
    g.add(r);
  }
  return g;
}

function modeloPessoa(roupa = 0xffffff) {
  const g = new THREE.Group();
  const corpo = new THREE.Mesh(G.cilindro, pintura(roupa));
  corpo.scale.set(0.22, 1.15, 0.22);
  corpo.position.y = 0.85;
  const cabeca = new THREE.Mesh(G.esfera, M.pele);
  cabeca.scale.setScalar(0.16);
  cabeca.position.y = 1.6;
  g.add(corpo, cabeca);
  return g;
}

function modeloDuasRodas(moto, cor, roupa) {
  const g = new THREE.Group();
  for (const z of [-0.6, 0.6]) {
    const r = new THREE.Mesh(G.rodaFina, M.roda);
    r.position.set(0, 0.34, z);
    g.add(r);
  }
  const quadro = pintura(cor);
  g.add(caixa(quadro, 0.14, moto ? 0.38 : 0.08, 1.1, 0, 0.6, 0));
  g.userData.pintura = quadro;
  const piloto = modeloPessoa(roupa);
  piloto.scale.setScalar(0.85);
  piloto.position.set(0, 0.35, 0.1);
  g.add(piloto);
  return g;
}

function modeloSemaforo() {
  const g = new THREE.Group();
  const poste = new THREE.Mesh(G.cilindro, M.poste);
  poste.scale.set(0.09, 4.6, 0.09);
  poste.position.y = 2.3;
  g.add(poste);
  g.add(caixa(M.caixa, 0.42, 1.1, 0.35, 0, 4.9, 0));
  const luzes = {};
  [['vermelho', 5.25], ['amarelo', 4.9], ['verde', 4.55]].forEach(([nome, y]) => {
    const l = new THREE.Mesh(G.esfera, M.luzOff);
    l.scale.setScalar(0.13);
    l.position.set(0, y, 0.19);
    g.add(l);
    luzes[nome] = l;
  });
  g.userData.luzes = luzes;
  return g;
}

// Cada objeto recebe a cor real vista pela câmera (o.pintura) ou uma cor fixa pelo id.
const FABRICA = {
  carro: (o) => modeloCarro(pintura(o.pintura ?? escolher(CORES_CARRO, o.id))),
  caminhao: (o) => modeloCaminhao(o.pintura ?? escolher(CORES_CARRO, o.id)),
  onibus: (o) => modeloOnibus(o.pintura ?? escolher(CORES_ONIBUS, o.id)),
  pessoa: (o) => modeloPessoa(escolher(CORES_ROUPA, o.id)),
  bike: (o) => modeloDuasRodas(false, o.pintura ?? 0x06d6a0, escolher(CORES_ROUPA, o.id + 'r')),
  moto: (o) => modeloDuasRodas(true, o.pintura ?? escolher(CORES_CARRO, o.id), escolher(CORES_ROUPA, o.id + 'r')),
  semaforo: modeloSemaforo,
};

function semCulling(obj) {
  // A câmera usa a matriz do mapa; o culling do Three erraria, então desligamos.
  obj.traverse((o) => { o.frustumCulled = false; });
  return obj;
}

/**
 * Cria a camada 3D.
 * @param {() => {pos: [number, number] | null, bearing: number}} getEgo
 */
export function criarCamada3D(getEgo) {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x2a3040, 1.6));
  const sol = new THREE.DirectionalLight(0xffffff, 1.6);
  sol.position.set(-40, 80, 30);
  scene.add(sol);

  // Grupo que gira junto com o carro
  const ego = new THREE.Group();
  scene.add(ego);

  const meuCarro = semCulling(modeloCarro(M.ego, 1.9, 4.7));
  ego.add(meuCarro);
  const anel = new THREE.Mesh(
    new THREE.RingGeometry(3.2, 3.6, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
  );
  anel.position.y = 0.05;
  ego.add(semCulling(anel));

  const malhas = new Map(); // id -> {obj, x, z}
  let escalaModelos = 1; // aumenta os modelos quando a câmera está mais longe
  let objetos = [];

  const layer = {
    id: 'ia-3d',
    type: 'custom',
    renderingMode: '3d',
    onAdd(map, gl) {
      this.map = map;
      this.camera = new THREE.Camera();
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      this.renderer.autoClear = false;
    },
    render(gl, matrix) {
      const e = getEgo();
      if (!e.pos) return;
      const mc = maplibregl.MercatorCoordinate.fromLngLat(e.pos, 0);
      const s = mc.meterInMercatorCoordinateUnits();
      const local = new THREE.Matrix4()
        .makeTranslation(mc.x, mc.y, mc.z)
        .scale(new THREE.Vector3(s, -s, s))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(local);

      ego.rotation.y = -(e.bearing * Math.PI) / 180;
      escalaModelos = e.escala || 1;
      meuCarro.scale.setScalar(escalaModelos);
      anel.scale.setScalar(escalaModelos);
      atualizarMalhas();
      anel.material.opacity = 0.35 + Math.sin(performance.now() / 400) * 0.2;

      // Limpa a profundidade: carros e pessoas sempre aparecem, mesmo atrás de prédios.
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      this.renderer.resetState();
      this.renderer.render(scene, this.camera);
      this.map.triggerRepaint();
    },
  };

  function atualizarMalhas() {
    const vistos = new Set();
    // Carro líder: o mais próximo à frente, na mesma faixa.
    let lider = null;
    for (const o of objetos) {
      if (['carro', 'caminhao', 'onibus'].includes(o.tipo) && Math.abs(o.x) < 1.8 && o.z > 0 && (!lider || o.z < lider.z)) lider = o;
    }
    for (const o of objetos) {
      vistos.add(o.id);
      let m = malhas.get(o.id);
      if (!m) {
        const fab = FABRICA[o.tipo];
        if (!fab) continue;
        const obj = semCulling(fab(o));
        obj.rotation.y = o.tipo === 'pessoa' ? Math.random() * Math.PI * 2 : 0;
        obj.scale.setScalar(0.01);
        ego.add(obj);
        m = { obj, x: o.x, z: o.z, escala: 0.01 };
        malhas.set(o.id, m);
      }
      // Suaviza o movimento
      m.x += (o.x - m.x) * 0.2;
      m.z += (o.z - m.z) * 0.2;
      m.escala += (1 - m.escala) * 0.15;
      m.obj.position.set(m.x, 0, -m.z);
      m.obj.scale.setScalar(m.escala * escalaModelos);
      const tinta = m.obj.userData.pintura;
      if (tinta) {
        // Cor real vinda da câmera pode ir se ajustando
        if (o.pintura != null) tinta.color.lerp(new THREE.Color(o.pintura), 0.1);
        // Veículo da frente na nossa faixa brilha em azul
        tinta.emissive.setHex(o === lider ? 0x0b3aa8 : 0x000000);
      }
      if (o.tipo === 'semaforo') {
        const luzes = m.obj.userData.luzes;
        for (const nome in luzes) luzes[nome].material = o.cor === nome ? M.luz[nome] : M.luzOff;
      }
    }
    for (const [id, m] of malhas) {
      if (!vistos.has(id)) { ego.remove(m.obj); malhas.delete(id); }
    }
  }

  return {
    layer,
    /** @param {{id:any, tipo:string, x:number, z:number, cor?:string}[]} lista  x = metros à direita, z = metros à frente */
    setObjetos(lista) { objetos = lista; },
  };
}
