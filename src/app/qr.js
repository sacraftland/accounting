// ---- QR code encoder (byte mode, error correction M, versions 1-25) ----
// Written for this app. Algorithm per ISO/IEC 18004.
const QR = (() => {
  const ECC_M = [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28];
  const BLK_M = [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21];
  const rawModules = v => { let r = (16*v+128)*v+64; if (v >= 2) { const n = Math.floor(v/7)+2; r -= (25*n-10)*n-55; if (v >= 7) r -= 36; } return r; };
  const dataCap = v => Math.floor(rawModules(v)/8) - ECC_M[v]*BLK_M[v];
  const gmul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; };
  function rsDivisor(n) { const r = new Array(n).fill(0); r[n-1] = 1; let root = 1;
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { r[j] = gmul(r[j], root); if (j+1 < n) r[j] ^= r[j+1]; } root = gmul(root, 2); } return r; }
  function rsRemainder(data, div) { const r = div.map(() => 0);
    for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => r[i] ^= gmul(c, f)); } return r; }
  function alignPos(v) { if (v === 1) return []; const n = Math.floor(v/7)+2; const step = Math.ceil((v*4+4)/(n*2-2))*2;
    const res = [6]; for (let p = v*4+10; res.length < n; p -= step) res.splice(1, 0, p); return res; }

  function encode(bytes) {
    let v = 1; for (; v <= 25; v++) { const cc = v < 10 ? 8 : 16; if (4 + cc + bytes.length*8 <= dataCap(v)*8) break; }
    if (v > 25) throw new Error('QR data too long');
    const bits = []; const put = (val, len) => { for (let i = len-1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
    const cap = dataCap(v)*8; put(0, Math.min(4, cap - bits.length)); while (bits.length % 8) bits.push(0);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i+8).reduce((a, b) => a*2+b, 0));
    for (let p = 0xEC; data.length < dataCap(v); p ^= 0xEC ^ 0x11) data.push(p);
    // split into blocks + ECC, interleave
    const nb = BLK_M[v], ecl = ECC_M[v], raw = Math.floor(rawModules(v)/8);
    const nShort = nb - raw % nb, shortLen = Math.floor(raw/nb), div = rsDivisor(ecl), blocks = [];
    for (let i = 0, k = 0; i < nb; i++) { const d = data.slice(k, k + shortLen - ecl + (i < nShort ? 0 : 1)); k += d.length;
      const e = rsRemainder(d, div); if (i < nShort) d.push(0); blocks.push(d.concat(e)); }
    const cw = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecl || j >= nShort) cw.push(b[i]); });

    const size = v*4+17; const M = [...Array(size)].map(() => Array(size).fill(false)); const F = [...Array(size)].map(() => Array(size).fill(false));
    const set = (x, y, d) => { M[y][x] = d; F[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx+dx, y = cy+dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4); } };
    finder(3, 3); finder(size-4, 3); finder(3, size-4);
    const ap = alignPos(v); ap.forEach((a, i) => ap.forEach((b, j) => { if ((i === 0 && j === 0) || (i === 0 && j === ap.length-1) || (i === ap.length-1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a+dx, b+dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
    const drawFormat = mask => { const d = (0 << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const b = ((d << 10) | r) ^ 0x5412, bit = i => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i)); set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14-i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size-1-i, 8, bit(i)); for (let i = 8; i < 15; i++) set(8, size-15+i, bit(i)); set(8, size-8, true); };
    drawFormat(0);
    if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25); const b = (v << 12) | r;
      for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) === 1, a = size-11+i%3, c = Math.floor(i/3); set(a, c, d); set(c, a, d); } }
    // place data
    let i = 0; for (let right = size-1; right >= 1; right -= 2) { if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) { const x = right-j, up = ((right+1) & 2) === 0, y = up ? size-1-vert : vert;
        if (!F[y][x] && i < cw.length*8) { M[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; } } }
    const maskFn = [(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,(x,y)=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,
      (x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0];
    const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && maskFn[m](x, y)) M[y][x] = !M[y][x]; };
    const penalty = () => { let p = 0, dark = 0;
      for (let a = 0; a < size; a++) { let rx = 1, ry = 1;
        for (let b = 1; b < size; b++) { if (M[a][b] === M[a][b-1]) { rx++; if (rx === 5) p += 3; else if (rx > 5) p++; } else rx = 1;
          if (M[b][a] === M[b-1][a]) { ry++; if (ry === 5) p += 3; else if (ry > 5) p++; } else ry = 1; } }
      for (let y = 0; y < size-1; y++) for (let x = 0; x < size-1; x++) { const c = M[y][x]; if (c === M[y][x+1] && c === M[y+1][x] && c === M[y+1][x+1]) p += 3; }
      M.forEach(r => r.forEach(c => dark += c)); p += Math.floor(Math.abs(dark*20 - size*size*10) / (size*size)) * 10; return p; };
    let best = 0, bestP = Infinity;
    for (let m = 0; m < 8; m++) { applyMask(m); drawFormat(m); const pp = penalty(); if (pp < bestP) { bestP = pp; best = m; } applyMask(m); }
    applyMask(best); drawFormat(best);
    return M;
  }

  function svg(matrix, px = 4) { const n = matrix.length, q = 4, s = n + q*2; let d = '';
    matrix.forEach((row, y) => row.forEach((c, x) => { if (c) d += `M${x+q},${y+q}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s*px}" height="${s*px}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`; }

  // ZATCA TLV: 1 seller, 2 VAT no., 3 timestamp, 4 total incl. VAT, 5 VAT
  function zatcaTLV({ seller, vatNo, timestamp, total, vat }) {
    const enc = new TextEncoder(), out = [];
    [seller, vatNo, timestamp, total, vat].forEach((val, i) => { const b = enc.encode(String(val)); if (b.length > 255) throw new Error('TLV value too long'); out.push(i+1, b.length, ...b); });
    let bin = ''; out.forEach(b => bin += String.fromCharCode(b)); return btoa(bin);
  }
  const ascii = s => Array.from(s, c => c.charCodeAt(0));
  return { encode, svg, zatcaTLV, ascii };
})();
if (typeof module !== 'undefined') module.exports = QR;
