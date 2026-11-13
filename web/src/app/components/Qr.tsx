// A QR code drawn as one SVG path, generated in the page (no network).

import { encode } from 'uqr';

export function qrPath(text: string): { size: number; d: string } {
  const { data, size } = encode(text, { ecc: 'M', border: 0 });
  let d = '';
  data.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let w = 1;
      while (row[x + w]) w++;
      d += `M${x} ${y}h${w}v1h${-w}z`;
      x += w;
    }
  });
  return { size, d };
}

export function Qr(props: { text: string; label: string; size?: number }) {
  const { size, d } = qrPath(props.text);
  const quiet = 3;
  const box = size + quiet * 2;
  return (
    <svg
      class="qr"
      role="img"
      aria-label={props.label}
      viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
      width={props.size ?? 168}
      height={props.size ?? 168}
      shape-rendering="crispEdges"
      data-test="qr"
      data-text={props.text}
    >
      <rect x={-quiet} y={-quiet} width={box} height={box} fill="#fff" />
      <path d={d} fill="#1c1b1a" />
    </svg>
  );
}
