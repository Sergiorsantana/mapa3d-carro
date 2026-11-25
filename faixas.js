/* Faixas da rua desenhadas no chão, ao longo do traçado real de cada via (acompanha as curvas).
 * Os dados gratuitos do mapa não trazem o número de faixas, então ele é estimado pelo tipo de via.
 */

const LARGURA_FAIXA = 3.3; // metros
// Faixas por sentido, conforme o tipo de via (OpenMapTiles "class")
const GRUPOS = [
  { n: 3, classes: ['motorway'] },
  { n: 2, classes: ['trunk', 'primary', 'secondary'] },
  { n: 1, classes: ['tertiary', 'minor'] },
];

// Converte metros em pixels para qualquer zoom (tiles de 512 px)
function metros(m, lat) {
  const k = 512 / (40075016 * Math.cos((lat * Math.PI) / 180));
  return ['interpolate', ['exponential', 2], ['zoom'], 14, m * k * 2 ** 14, 23, m * k * 2 ** 23];
}

const LARGURA_LINHA = ['interpolate', ['exponential', 2], ['zoom'], 15, 0.5, 17, 1, 19, 2.2, 21, 6];
const LARGURA_CENTRO = ['interpolate', ['exponential', 2], ['zoom'], 15, 0.8, 17, 1.6, 19, 3.5, 21, 9.6];

export function adicionarFaixas(map, src, lat, visivel = true) {
  if (!src || map.getLayer('faixa-0')) return;
  const antesDe = map.getLayer('predios-3d') ? 'predios-3d' : undefined;
  const mao = ['coalesce', ['get', 'oneway'], 0];
  let i = 0;
  const linha = (filtro, offset, tipo) => {
    const cor = tipo === 'centro' ? '#ffcc00' : '#ffffff';
    map.addLayer({
      id: `faixa-${i++}`,
      type: 'line',
      source: src,
      'source-layer': 'transportation',
      minzoom: 16,
      filter: filtro,
      layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: visivel ? 'visible' : 'none' },
      paint: {
        'line-color': cor,
        'line-opacity': tipo === 'borda' ? 0.85 : 0.75,
        'line-width': tipo === 'centro' ? LARGURA_CENTRO : LARGURA_LINHA,
        'line-offset': metros(offset, lat),
        ...(tipo === 'divisoria' ? { 'line-dasharray': [5, 9] } : {}),
      },
    }, antesDe);
  };

  for (const { n, classes } of GRUPOS) {
    const base = ['all',
      ['in', ['get', 'class'], ['literal', classes]],
      ['!=', ['get', 'brunnel'], 'tunnel'],
    ];
    const maoUnica = [...base, ['in', mao, ['literal', [1, -1]]]];
    const maoDupla = [...base, ['!', ['in', mao, ['literal', [1, -1]]]]];

    // Mão única: n faixas centradas na linha da via
    const w = n * LARGURA_FAIXA;
    linha(maoUnica, -w / 2, 'borda');
    linha(maoUnica, w / 2, 'borda');
    for (let k = 1; k < n; k++) linha(maoUnica, -w / 2 + k * LARGURA_FAIXA, 'divisoria');

    // Mão dupla: faixa amarela no meio, n faixas para cada lado
    linha(maoDupla, 0, 'centro');
    for (let k = 1; k < n; k++) {
      linha(maoDupla, k * LARGURA_FAIXA, 'divisoria');
      linha(maoDupla, -k * LARGURA_FAIXA, 'divisoria');
    }
    linha(maoDupla, n * LARGURA_FAIXA, 'borda');
    linha(maoDupla, -n * LARGURA_FAIXA, 'borda');
  }
}

export function mostrarFaixas(map, visivel) {
  for (const l of map.getStyle()?.layers || []) {
    if (l.id.startsWith('faixa-')) map.setLayoutProperty(l.id, 'visibility', visivel ? 'visible' : 'none');
  }
}
