/* ================================================================
   ENGINE. Self-contained: the export button ships this exact function.
   createPipeline(W, H) -> { page, buf, frame(stack, x, y, opts), ... }
   ================================================================ */
function createPipeline(W, H) {
  const N = W * H, TAU = Math.PI * 2, HIST = 256;
  const page = new Uint8ClampedArray(N * 4).fill(255);
  const img = new Uint8ClampedArray(N * 4), buf = new Uint8ClampedArray(N * 4);
  const tmp = new Uint8ClampedArray(N * 4), pre = new Uint8ClampedArray(N * 4), mpre = new Uint8ClampedArray(N * 4);
  const mark = new Uint8Array(N);
  /* reach: where the lens has been lately. effects only show there unless --spill says otherwise */
  const reach = new Uint8Array(N), buf32 = new Uint32Array(buf.buffer), spre32 = new Uint32Array(N);
  let reachBox = null, spillMode = 'free';
  let markBox = null, markAge = 0, t = 0, fr = 0;

  const INK = [20, 16, 42], PAPER = [255, 255, 255], PINK = [243, 122, 154], COBALT = [42, 63, 230];
  const VERM = [255, 74, 28], YELLOW = [255, 210, 63], GREEN = [0, 163, 122];
  const INKS = [PINK, COBALT, VERM, YELLOW, GREEN];
  /* theme: in dark mode ink is light and paper is dark; dk() measures lightness relative to the paper */
  let DARK = false, inkL = 40, paperL = 230;
  const INK0 = [43, 42, 40], PAPER0 = [233, 231, 225], INKD = [216, 214, 208], PAPERD = [27, 27, 26];
  function setTheme(d) {
    DARK = d;
    const a = d ? INKD : INK0, b = d ? PAPERD : PAPER0;
    for (let c = 0; c < 3; c++) { INK[c] = a[c]; PAPER[c] = b[c]; }
    inkL = L(a[0], a[1], a[2]); paperL = L(b[0], b[1], b[2]);
  }
  /* dk(): 255 means paper, 0 means ink, in either theme */
  const dk = l => { const v = (l - inkL) / (paperL - inkL) * 255; return v < 0 ? 0 : v > 255 ? 255 : v; };
  const tint = w => [PAPER[0] + (INK[0] - PAPER[0]) * w, PAPER[1] + (INK[1] - PAPER[1]) * w, PAPER[2] + (INK[2] - PAPER[2]) * w];
  const hexCache = {};
  /* any CSS colour: hex, names, rgb(), hsl(). null when it can't be read */
  let colorCtx = null;
  const rgb = h => {
    if (Array.isArray(h)) return h;
    if (h in hexCache) return hexCache[h];
    const raw = String(h).trim();
    let s = raw.replace('#', '');
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map(c => c + c).join('');
    if (/^[0-9a-f]{6}$/i.test(s)) { const n = parseInt(s, 16); return hexCache[h] = [n >> 16 & 255, n >> 8 & 255, n & 255]; }
    if (typeof document !== 'undefined') {
      colorCtx = colorCtx || document.createElement('canvas').getContext('2d');
      colorCtx.fillStyle = '#010203'; colorCtx.fillStyle = raw;
      const v = colorCtx.fillStyle;
      if (v !== '#010203') {
        const m = /^#([0-9a-f]{6})$/i.exec(v), r = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
        if (m) { const n = parseInt(m[1], 16); return hexCache[h] = [n >> 16 & 255, n >> 8 & 255, n & 255]; }
        if (r) return hexCache[h] = [+r[1], +r[2], +r[3]];
      }
    }
    return hexCache[h] = null;
  };
  const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const L = (r, g, b) => (r * 3 + g * 6 + b) / 10;
  const idx = (x, y) => (y * W + x) * 4;
  const lum = i => L(buf[i], buf[i + 1], buf[i + 2]);
  const lumP = i => L(page[i], page[i + 1], page[i + 2]);
  const lumT = i => L(tmp[i], tmp[i + 1], tmp[i + 2]);
  const sm = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    x = x < 0 ? 0 : x >= W ? W - 1 : x; y = y < 0 ? 0 : y >= H ? H - 1 : y;
    return (y * W + x) * 4;
  };
  const put = (i, j) => { buf[i] = tmp[j]; buf[i + 1] = tmp[j + 1]; buf[i + 2] = tmp[j + 2]; };
  const setc = (i, c) => { buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; };
  const mixc = (i, c, w) => { buf[i] += (c[0] - buf[i]) * w; buf[i + 1] += (c[1] - buf[i + 1]) * w; buf[i + 2] += (c[2] - buf[i + 2]) * w; };
  const mixPut = (i, j, w) => { buf[i] += (tmp[j] - buf[i]) * w; buf[i + 1] += (tmp[j + 1] - buf[i + 1]) * w; buf[i + 2] += (tmp[j + 2] - buf[i + 2]) * w; };

  /* pointer: position, velocity, history */
  const P = {
    x: W / 2, y: H / 2, dx: 0, dy: 0, vx: 0, vy: 0, speed: 0, hw: 20, hh: 20, circle: false,
    hx: new Float32Array(HIST).fill(W / 2), hy: new Float32Array(HIST).fill(H / 2), hi: 0, held: [0, 0, 0],
    move(nx, ny) {
      this.dx = nx - this.x; this.dy = ny - this.y; this.x = nx; this.y = ny;
      this.vx += (this.dx - this.vx) * .25; this.vy += (this.dy - this.vy) * .25;
      this.speed = Math.hypot(this.vx, this.vy);
      this.hi = (this.hi + 1) % HIST; this.hx[this.hi] = nx; this.hy[this.hi] = ny;
    },
    past(n) { return (this.hi - n + HIST * 2) % HIST; },
  };
  const rad = () => Math.min(P.hw, P.hh);
  const lbox = () => [Math.max(0, Math.floor(P.x - P.hw)), Math.max(0, Math.floor(P.y - P.hh)),
    Math.min(W, Math.ceil(P.x + P.hw) + 1), Math.min(H, Math.ceil(P.y + P.hh) + 1)];
  const inL = (x, y) => {
    const nx = (x - P.x) / P.hw, ny = (y - P.y) / P.hh;
    return P.circle ? nx * nx + ny * ny <= 1 : nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1;
  };
  function snapRows(y0, y1) {
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H, Math.ceil(y1));
    if (y1 > y0) tmp.set(buf.subarray(y0 * W * 4, y1 * W * 4), y0 * W * 4);
  }
  const snap = (m = 100) => snapRows(P.y - P.hh - m, P.y + P.hh + m);
  function lens(fn) {
    const [x0, y0, x1, y1] = lbox(), circ = P.circle;
    for (let y = y0; y < y1; y++) {
      const uy = y - P.y, ny = uy / P.hh;
      for (let x = x0; x < x1; x++) {
        const ux = x - P.x, nx = ux / P.hw;
        const d = circ ? Math.sqrt(nx * nx + ny * ny) : Math.max(Math.abs(nx), Math.abs(ny));
        if (d <= 1) fn((y * W + x) * 4, x, y, d, ux, uy);
      }
    }
  }
  const warp = fn => { snap(); lens((i, x, y, d, ux, uy) => put(i, fn(x, y, d, ux, uy))); };
  function cells(s, fn) {
    const [x0, y0, x1, y1] = lbox();
    for (let gy = Math.floor(y0 / s); gy * s < y1; gy++) for (let gx = Math.floor(x0 / s); gx * s < x1; gx++) {
      const bx = gx * s, by = gy * s;
      if (!inL(bx + s / 2, by + s / 2)) continue;
      const ax = Math.max(bx, 0), ay = Math.max(by, 0), ex = Math.min(bx + s, W), ey = Math.min(by + s, H);
      if (ex > ax && ey > ay) fn(ax, ay, ex, ey, bx, by);
    }
  }

  const AV = [0, 0, 0];
  function avg(x0, y0, ex, ey) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < ey; y++) for (let x = x0; x < ex; x++) { const i = idx(x, y); r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++; }
    AV[0] = r / n; AV[1] = g / n; AV[2] = b / n;
    return AV;
  }
  function fill(x0, y0, ex, ey, c) { for (let y = y0; y < ey; y++) for (let x = x0; x < ex; x++) setc(idx(x, y), c); }

  /* marks: persistent effects bake into img; marks fade back to the page over ~4s */
  function grow(x0, y0, x1, y1) {
    markBox = markBox ? [Math.min(markBox[0], x0), Math.min(markBox[1], y0), Math.max(markBox[2], x1), Math.max(markBox[3], y1)] : [x0, y0, x1, y1];
    markAge = 0;
  }
  function bakeRect(x0, y0, x1, y1) {
    for (let y = y0; y < y1; y++) {
      img.set(buf.subarray(idx(x0, y), idx(x1, y)), idx(x0, y));
      mark.fill(255, y * W + x0, y * W + x1);
    }
    grow(x0, y0, x1, y1);
  }
  function stamp(i) {
    if (spillMode !== 'free') { const k = i >> 2; if (spillMode === 'lens' ? !inL(k % W, (k / W) | 0) : !reach[k]) return; }
    img[i] = buf[i]; img[i + 1] = buf[i + 1]; img[i + 2] = buf[i + 2];
    const k = i >> 2, x = k % W, y = (k / W) | 0;
    mark[k] = 255;
    grow(x, y, x + 1, y + 1);
  }
  function composite(keep) {
    buf.set(page);
    if (!markBox) return;
    if (keep) markAge = 0;
    const fade = keep ? 0 : 1;
    const [x0, y0, x1, y1] = markBox;
    for (let y = y0; y < y1; y++) for (let k = y * W + x0, e = y * W + x1; k < e; k++) {
      const m = mark[k];
      if (!m) continue;
      const i = k * 4, w = m / 255;
      buf[i] = page[i] + (img[i] - page[i]) * w;
      buf[i + 1] = page[i + 1] + (img[i + 1] - page[i + 1]) * w;
      buf[i + 2] = page[i + 2] + (img[i + 2] - page[i + 2]) * w;
      mark[k] = m - fade;
    }
    if (++markAge > 256) markBox = null;
  }

  /* cell grids for simulations */
  const state = {};
  const st = (key, make) => state[key] || (state[key] = make());
  function makeGrid(G, fields) {
    const g = { G, gw: Math.ceil(W / G), gh: Math.ceil(H / G), box: null };
    for (const k in fields) g[k] = new fields[k](g.gw * g.gh);
    return g;
  }
  function touch(g, m = 3) {
    const b = [Math.max(0, Math.floor((P.x - P.hw) / g.G) - m), Math.max(0, Math.floor((P.y - P.hh) / g.G) - m),
      Math.min(g.gw, Math.ceil((P.x + P.hw) / g.G) + m), Math.min(g.gh, Math.ceil((P.y + P.hh) / g.G) + m)];
    g.box = g.box ? [Math.min(g.box[0], b[0]), Math.min(g.box[1], b[1]), Math.max(g.box[2], b[2]), Math.max(g.box[3], b[3])] : b;
  }
  function touchCell(g, x, y) {
    const b = [Math.max(0, x - 2), Math.max(0, y - 2), Math.min(g.gw, x + 3), Math.min(g.gh, y + 3)];
    g.box = g.box ? [Math.min(g.box[0], b[0]), Math.min(g.box[1], b[1]), Math.max(g.box[2], b[2]), Math.max(g.box[3], b[3])] : b;
  }
  function eachCell(g, fn, inner) {
    if (!g.box) return;
    const e = inner ? 1 : 0;
    const [x0, y0, x1, y1] = g.box;
    for (let y = Math.max(e, y0); y < Math.min(g.gh - e, y1); y++)
      for (let x = Math.max(e, x0); x < Math.min(g.gw - e, x1); x++) fn(y * g.gw + x, x, y);
  }
  function lensCells(g, fn) {
    const [x0, y0, x1, y1] = lbox(), G = g.G;
    for (let y = Math.floor(y0 / G); y * G < y1 && y < g.gh; y++) for (let x = Math.floor(x0 / G); x * G < x1 && x < g.gw; x++)
      if (inL(x * G + G / 2, y * G + G / 2)) fn(y * g.gw + x, x, y);
  }
  function copyBack(g, from, to) {
    if (!g.box) return;
    const [x0, y0, x1, y1] = g.box;
    for (let y = y0; y < y1; y++) to.set(from.subarray(y * g.gw + x0, y * g.gw + x1), y * g.gw + x0);
  }
  function paintCell(g, x, y, c, w) {
    const G = g.G, x0 = x * G, y0 = y * G, x1 = Math.min(W, x0 + G), y1 = Math.min(H, y0 + G);
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
      const i = idx(px, py);
      if (w >= 1) setc(i, c); else mixc(i, c, w);
    }
  }
  const inkAt = (g, x, y) => dk(lumP(sm(x * g.G + g.G / 2, y * g.G + g.G / 2))) < 200;
  const cellSize = v => clamp(Math.round(v) || 3, 1, 16);

  /* ---------------- effects ---------------- */
  const E = [];
  const fx = (name, persist, params, desc, run) => E.push({ name, persist, params, desc, run });

  /* brushes: they move the page and leave marks */
  fx('smear', true, { strength: .92 }, 'Drags the page along with your motion.', p => {
    if (P.dx * P.dx + P.dy * P.dy < .25) return;
    snap();
    lens((i, x, y, d) => mixPut(i, sm(x - P.dx, y - P.dy), p.strength * (1 - d * d)));
  });
  fx('push', true, { force: 1 }, 'The page flows outward from the cursor.', p => {
    snap();
    lens((i, x, y, d, ux, uy) => { const k = 1 - .05 * p.force * (1 - d); put(i, sm(P.x + ux * k, P.y + uy * k)); });
  });
  fx('pull', true, { force: 1 }, 'The page drains into the cursor.', p => {
    snap();
    lens((i, x, y, d, ux, uy) => { const k = 1 + .05 * p.force * (1 - d); put(i, sm(P.x + ux * k, P.y + uy * k)); });
  });
  fx('vortex', true, { spin: .08 }, 'A whirlpool that keeps winding the page tighter.', p => {
    snap();
    const R0 = rad();
    lens((i, x, y, d, ux, uy) => {
      const r = Math.hypot(ux, uy) / R0;
      if (r > 1) return;
      const a = p.spin * (1 - r) ** 2, c = Math.cos(a), s = Math.sin(a);
      put(i, sm(P.x + ux * c - uy * s, P.y + ux * s + uy * c));
    });
  });
  fx('melt', true, { rate: 3 }, 'Columns drip downward at different speeds.', p => {
    snap();
    lens((i, x, y, d) => put(i, sm(x, y - (1 + hash(x, 0) * p.rate) * (1 - d))));
  });
  fx('diffuse', true, { spread: 2 }, 'Pixels jitter apart like sand in water.', p => {
    snap();
    const s = p.spread * 2;
    lens((i, x, y) => put(i, sm(x + (Math.random() - .5) * s, y + (Math.random() - .5) * s)));
  });
  const vn = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  fx('flow', true, { scale: .015, speed: 1.5 }, 'Advects the page along a curl-noise field, like marbled paper.', p => {
    snap();
    const s = p.scale, z = t * .05, k = p.speed / (2 * s);
    const n = (x, y) => vn(x * s + z, y * s - z);
    lens((i, x, y) => put(i, sm(x - (n(x, y + 1) - n(x, y - 1)) * k, y + (n(x + 1, y) - n(x - 1, y)) * k)));
  });
  fx('voter', true, { rate: .35 }, 'Voter model: every pixel copies a random neighbor, so regions coarsen into blobs.', p => {
    snap();
    lens((i, x, y) => { if (Math.random() < p.rate) put(i, sm(x + (Math.random() * 3 | 0) - 1, y + (Math.random() * 3 | 0) - 1)); });
  });
  fx('sand', true, { passes: 2 }, 'Falling sand. Ink becomes grains that pour and pile up at the bottom of the lens.', p => {
    const [x0, y0, x1, y1] = lbox();
    const empty = i => dk(lum(i)) > 236;
    const swap = (a, b) => { for (let c = 0; c < 3; c++) { const v = buf[a + c]; buf[a + c] = buf[b + c]; buf[b + c] = v; } };
    for (let pass = 0; pass < clamp(Math.round(p.passes), 1, 6); pass++) {
      for (let y = y1 - 2; y >= y0; y--) {
        const flip = (fr + y + pass) & 1;
        for (let k = 0; k < x1 - x0; k++) {
          const x = flip ? x0 + k : x1 - 1 - k, i = idx(x, y);
          if (empty(i) || !inL(x, y)) continue;
          const b = idx(x, y + 1);
          if (inL(x, y + 1) && empty(b)) { swap(i, b); continue; }
          const s = Math.random() < .5 ? -1 : 1;
          for (const dx of [s, -s]) {
            const nx = x + dx;
            if (nx >= 0 && nx < W && inL(nx, y + 1) && empty(idx(nx, y + 1))) { swap(i, idx(nx, y + 1)); break; }
          }
        }
      }
    }
  });

  /* simulations: they read the page's ink and run on their own */
  fx('automata', false, { rule: 'B3/S23', seed: 2, cell: 3 }, "Conway's Game of Life seeded from the page's ink. Try --rule: B36/S23.", p => {
    const G = cellSize(p.cell);
    const g = st('life' + G, () => makeGrid(G, { a: Uint8Array, b: Uint8Array, heat: Float32Array }));
    const m = /B(\d*)\/S(\d*)/i.exec(String(p.rule)) || [0, '3', '23'];
    touch(g);
    const n = Math.round(1 + P.speed * p.seed) * 6;
    for (let s = 0; s < n; s++) {
      const x = P.x + (Math.random() * 2 - 1) * P.hw, y = P.y + (Math.random() * 2 - 1) * P.hh;
      if (!inL(x, y)) continue;
      const cx = Math.floor(x / G), cy = Math.floor(y / G);
      if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) continue;
      if (inkAt(g, cx, cy) || Math.random() < .2) { const k = cy * g.gw + cx; g.a[k] = 1; g.heat[k] = 255; }
    }
    if (fr % 2 === 0) {
      const gw = g.gw;
      eachCell(g, k => {
        const a = g.a, c = a[k - gw - 1] + a[k - gw] + a[k - gw + 1] + a[k - 1] + a[k + 1] + a[k + gw - 1] + a[k + gw] + a[k + gw + 1];
        const alive = (a[k] ? m[2] : m[1]).includes(c);
        g.b[k] = alive ? 1 : 0;
        g.heat[k] = alive ? 255 : g.heat[k] > 12 ? g.heat[k] * .78 : 0;
      }, true);
      copyBack(g, g.b, g.a);
    }
    eachCell(g, (k, x, y) => {
      const h = g.heat[k];
      if (!h) return;
      const w = h / 255, G2 = g.G;
      for (let py = y * G2; py < Math.min(H, y * G2 + G2); py++) for (let px = x * G2; px < Math.min(W, x * G2 + G2); px++) {
        const i = idx(px, py);
        buf[i] += (255 - 2 * buf[i]) * w; buf[i + 1] += (255 - 2 * buf[i + 1]) * w; buf[i + 2] += (255 - 2 * buf[i + 2]) * w;
      }
    });
  });
  fx('brain', false, { seed: .4, cell: 3 }, "Brian's Brain: ink fires, burns out, and throws off gliders.", p => {
    const dying = tint(.35);
    const G = cellSize(p.cell);
    const g = st('brain' + G, () => makeGrid(G, { a: Uint8Array, b: Uint8Array }));
    touch(g);
    lensCells(g, (k, x, y) => { if (!g.a[k] && inkAt(g, x, y) && Math.random() < p.seed) g.a[k] = 1; });
    if (fr % 2 === 0) {
      const gw = g.gw;
      eachCell(g, k => {
        const a = g.a, s = a[k];
        if (s === 1) { g.b[k] = 2; return; }
        if (s === 2) { g.b[k] = 0; return; }
        const c = (a[k - gw - 1] === 1) + (a[k - gw] === 1) + (a[k - gw + 1] === 1) + (a[k - 1] === 1) + (a[k + 1] === 1)
          + (a[k + gw - 1] === 1) + (a[k + gw] === 1) + (a[k + gw + 1] === 1);
        g.b[k] = c === 2 ? 1 : 0;
      }, true);
      copyBack(g, g.b, g.a);
    }
    eachCell(g, (k, x, y) => { const s = g.a[k]; if (s) paintCell(g, x, y, s === 1 ? INK : dying, 1); });
  });
  fx('cyclic', false, { states: 14, threshold: 1, cell: 3 }, 'Cyclic automaton: each color eats the next until spirals form.', p => {
    const G = cellSize(p.cell), n = clamp(Math.round(p.states), 3, 24);
    const g = st('cyc' + G, () => { const g = makeGrid(G, { a: Int8Array, b: Int8Array }); g.a.fill(-1); g.b.fill(-1); return g; });
    g.ramp = []; for (let k = 0; k < n; k++) g.ramp.push(tint(k / (n - 1)));
    touch(g);
    lensCells(g, (k, x, y) => {
      if (g.a[k] < 0) g.a[k] = inkAt(g, x, y) ? 0 : Math.random() * n | 0;
    });
    const gw = g.gw, th = Math.max(1, p.threshold);
    eachCell(g, k => {
      const a = g.a, s = a[k];
      if (s < 0) { g.b[k] = -1; return; }
      const nx = s + 1 >= n ? 0 : s + 1;
      const c = (a[k - gw - 1] === nx) + (a[k - gw] === nx) + (a[k - gw + 1] === nx) + (a[k - 1] === nx) + (a[k + 1] === nx)
        + (a[k + gw - 1] === nx) + (a[k + gw] === nx) + (a[k + gw + 1] === nx);
      g.b[k] = c >= th ? nx : s >= n ? 0 : s;
    }, true);
    copyBack(g, g.b, g.a);
    eachCell(g, (k, x, y) => { const s = g.a[k]; if (s >= 0) paintCell(g, x, y, g.ramp[s % n], 1); });
  });
  fx('cascade', false, { rule: 90 }, 'Elementary automaton: each row under the cursor is computed from the row above it. Try rule 30 or 110.', p => {
    const rule = clamp(Math.round(p.rule), 0, 255);
    const [x0, y0, x1, y1] = lbox();
    for (let y = Math.max(y0, Math.floor(P.y) + 1, 1); y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!inL(x, y)) continue;
      const l = dk(lum(sm(x - 1, y - 1))) < 128 ? 4 : 0, c = dk(lum(sm(x, y - 1))) < 128 ? 2 : 0, r = dk(lum(sm(x + 1, y - 1))) < 128 ? 1 : 0;
      setc(idx(x, y), (rule >> (l | c | r)) & 1 ? INK : PAPER);
    }
  });
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  fx('ants', false, { count: 8, steps: 120, cell: 3 }, "Langton's ants walk the page flipping cells. Ink turns them one way, paper the other.", p => {
    const G = cellSize(p.cell);
    const g = st('ants' + G, () => { const g = makeGrid(G, { flip: Uint8Array }); g.ants = []; return g; });
    const want = clamp(Math.round(p.count), 1, 60);
    while (g.ants.length < want) g.ants.push({ x: Math.floor(P.x / G), y: Math.floor(P.y / G), d: Math.random() * 4 | 0, life: 8000 });
    const steps = clamp(Math.round(p.steps), 1, 400);
    for (const a of g.ants) for (let s = 0; s < steps; s++) {
      if (a.x < 0 || a.y < 0 || a.x >= g.gw || a.y >= g.gh) { a.life = 0; break; }
      const k = a.y * g.gw + a.x, on = inkAt(g, a.x, a.y) !== !!g.flip[k];
      a.d = (a.d + (on ? 3 : 1)) % 4;
      g.flip[k] ^= 1;
      touchCell(g, a.x, a.y);
      a.x += DX[a.d]; a.y += DY[a.d];
      if (--a.life <= 0) break;
    }
    g.ants = g.ants.filter(a => a.life > 0);
    eachCell(g, (k, x, y) => {
      if (!g.flip[k]) return;
      for (let py = y * G; py < Math.min(H, y * G + G); py++) for (let px = x * G; px < Math.min(W, x * G + G); px++) {
        const i = idx(px, py); buf[i] = 255 - buf[i]; buf[i + 1] = 255 - buf[i + 1]; buf[i + 2] = 255 - buf[i + 2];
      }
    });
  });
  fx('sandpile', false, { drop: 40, cell: 3 }, 'Abelian sandpile: grains pile up at the cursor and topple into fractals. Ink swallows grains.', p => {
    const G = cellSize(p.cell);
    const g = st('pile' + G, () => makeGrid(G, { a: Int32Array }));
    const cx = Math.floor(P.x / G), cy = Math.floor(P.y / G), gw = g.gw;
    if (cx >= 1 && cy >= 1 && cx < gw - 1 && cy < g.gh - 1) { g.a[cy * gw + cx] += Math.max(1, Math.round(p.drop)); touchCell(g, cx, cy); }
    for (let sweep = 0; sweep < 12; sweep++) {
      eachCell(g, (k, x, y) => {
        const v = g.a[k];
        if (v < 4) return;
        const q = v >> 2;
        g.a[k] = v - q * 4;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 1 || ny < 1 || nx >= gw - 1 || ny >= g.gh - 1 || inkAt(g, nx, ny)) continue;
          g.a[ny * gw + nx] += q;
          touchCell(g, nx, ny);
        }
      }, true);
    }
    const C = [null, tint(.3), tint(.6), INK];
    eachCell(g, (k, x, y) => { const v = g.a[k]; if (v) paintCell(g, x, y, C[Math.min(3, v)], 1); });
  });
  fx('physarum', false, { agents: 1500, sense: 9, turn: .45, decay: .92 }, 'Slime-mould agents follow each other’s trails and the page’s ink, wiring it into networks.', p => {
    const G = 2;
    const g = st('phy', () => { const g = makeGrid(G, { tr: Float32Array, t2: Float32Array }); g.ag = []; return g; });
    const n = clamp(Math.round(p.agents), 50, 6000), gw = g.gw, gh = g.gh;
    for (let k = 0; k < 60 && g.ag.length < n; k++) {
      const x = P.x + (Math.random() * 2 - 1) * P.hw, y = P.y + (Math.random() * 2 - 1) * P.hh;
      if (inL(x, y) && x >= 0 && y >= 0 && x < W && y < H) g.ag.push({ x, y, a: Math.random() * TAU });
    }
    if (g.ag.length > n) g.ag.length = n;
    touch(g, 6);
    const sense = (x, y) => {
      const cx = x / G | 0, cy = y / G | 0;
      if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) return -1;
      return g.tr[cy * gw + cx] + (dk(lumP(sm(x, y))) < 200 ? 2 : 0);
    };
    const sd = p.sense, sa = .6;
    for (const a of g.ag) {
      const f = sense(a.x + Math.cos(a.a) * sd, a.y + Math.sin(a.a) * sd);
      const l = sense(a.x + Math.cos(a.a - sa) * sd, a.y + Math.sin(a.a - sa) * sd);
      const r = sense(a.x + Math.cos(a.a + sa) * sd, a.y + Math.sin(a.a + sa) * sd);
      if (f < l || f < r) a.a += l > r ? -p.turn : r > l ? p.turn : (Math.random() - .5) * 2 * p.turn;
      a.x += Math.cos(a.a); a.y += Math.sin(a.a);
      if (a.x < 0 || a.y < 0 || a.x >= W || a.y >= H) { a.a += Math.PI; a.x = clamp(a.x, 0, W - 1); a.y = clamp(a.y, 0, H - 1); }
      const cx = a.x / G | 0, cy = a.y / G | 0, k = cy * gw + cx;
      g.tr[k] = Math.min(4, g.tr[k] + 1);
      touchCell(g, cx, cy);
    }
    eachCell(g, k => { g.t2[k] = (g.tr[k] * 4 + g.tr[k - 1] + g.tr[k + 1] + g.tr[k - gw] + g.tr[k + gw]) / 8 * p.decay; }, true);
    copyBack(g, g.t2, g.tr);
    eachCell(g, (k, x, y) => { const v = g.tr[k]; if (v > .05) paintCell(g, x, y, INK, Math.min(1, v * .6)); });
  });
  fx('coral', false, { walkers: 400, steps: 60 }, 'Diffusion-limited aggregation: random walkers stick to ink and grow coral off the page.', p => {
    const s = st('coral', () => ({ w: [] }));
    const spawn = () => ({ x: Math.round(P.x + (Math.random() * 2 - 1) * P.hw), y: Math.round(P.y + (Math.random() * 2 - 1) * P.hh) });
    const n = clamp(Math.round(p.walkers), 1, 1000);
    while (s.w.length < n) s.w.push(spawn());
    s.w.length = n;
    for (let w = 0; w < n; w++) {
      const a = s.w[w];
      for (let k = 0; k < p.steps; k++) {
        const d = Math.random() * 4 | 0;
        a.x += DX[d]; a.y += DY[d];
        if (!inL(a.x, a.y) || a.x < 1 || a.y < 1 || a.x >= W - 1 || a.y >= H - 1) { s.w[w] = spawn(); break; }
        const i = idx(a.x, a.y);
        if (dk(lum(i)) < 200) { s.w[w] = spawn(); break; }
        let hit = -1;
        for (let q = 0; q < 4; q++) { const j = idx(a.x + DX[q], a.y + DY[q]); if (dk(lum(j)) < 200) { hit = j; break; } }
        if (hit >= 0) { buf[i] = buf[hit]; buf[i + 1] = buf[hit + 1]; buf[i + 2] = buf[hit + 2]; stamp(i); s.w[w] = spawn(); break; }
      }
    }
  });
  fx('water', false, { damp: .985, refract: 6, cell: 2 }, 'A wave equation under the page. Moving stirs it and the page refracts through the ripples.', p => {
    const G = cellSize(p.cell);
    const g = st('water' + G, () => makeGrid(G, { a: Float32Array, b: Float32Array }));
    const gw = g.gw;
    if (P.speed > .2) {
      const cx = Math.floor(P.x / G), cy = Math.floor(P.y / G);
      for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++)
        if (x > 0 && y > 0 && x < gw - 1 && y < g.gh - 1) g.a[y * gw + x] -= Math.min(P.speed, 10) * 2;
      touch(g, 4);
    }
    if (!g.box) return;
    let peak = 0;
    eachCell(g, k => {
      const v = (g.a[k - 1] + g.a[k + 1] + g.a[k - gw] + g.a[k + gw]) / 2 - g.b[k];
      g.b[k] = v * p.damp;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }, true);
    [g.a, g.b] = [g.b, g.a];
    const [bx0, by0, bx1, by1] = g.box;
    snapRows(by0 * G - 20, by1 * G + 20);
    for (let y = Math.max(1, by0) * G; y < Math.min(g.gh - 1, by1) * G && y < H; y++) for (let x = Math.max(1, bx0) * G; x < Math.min(gw - 1, bx1) * G && x < W; x++) {
      const k = Math.floor(y / G) * gw + Math.floor(x / G);
      const dx = g.a[k + 1] - g.a[k - 1], dy = g.a[k + gw] - g.a[k - gw];
      if (dx * dx + dy * dy < .002) continue;
      const i = idx(x, y);
      put(i, sm(x + dx * p.refract, y + dy * p.refract));
      const sh = clamp(dx * 18, -40, 40);
      buf[i] += sh; buf[i + 1] += sh; buf[i + 2] += sh;
    }
    if (peak < .02) { g.a.fill(0); g.b.fill(0); g.box = null; }
  });
  fx('flock', false, { birds: 120, carry: 2 }, 'A murmuration that follows you and drags the page’s pixels along its flight paths.', p => {
    const s = st('flock', () => ({ b: [] }));
    const n = clamp(Math.round(p.birds), 5, 600), c = clamp(Math.round(p.carry), 1, 8);
    while (s.b.length < n) s.b.push({ x: P.x + (Math.random() - .5) * P.hw * 2, y: P.y + (Math.random() - .5) * P.hh * 2, vx: Math.random() - .5, vy: Math.random() - .5 });
    s.b.length = n;
    for (const b of s.b) {
      let cx = 0, cy = 0, ax = 0, ay = 0, sx = 0, sy = 0, m = 0;
      for (const o of s.b) {
        if (o === b) continue;
        const dx = o.x - b.x, dy = o.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 > 900) continue;
        m++; cx += o.x; cy += o.y; ax += o.vx; ay += o.vy;
        if (d2 < 36) { sx -= dx; sy -= dy; }
      }
      if (m) {
        b.vx += (cx / m - b.x) * .005 + (ax / m - b.vx) * .05 + sx * .03;
        b.vy += (cy / m - b.y) * .005 + (ay / m - b.vy) * .05 + sy * .03;
      }
      b.vx += (P.x - b.x) * .0015; b.vy += (P.y - b.y) * .0015;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 3) { b.vx *= 3 / sp; b.vy *= 3 / sp; } else if (sp < 1) { b.vx *= 1.2; b.vy *= 1.2; }
      const ox = b.x, oy = b.y;
      b.x = clamp(b.x + b.vx, 0, W - 1); b.y = clamp(b.y + b.vy, 0, H - 1);
      for (let dy = -c; dy <= c; dy++) for (let dx = -c; dx <= c; dx++) {
        const j = sm(ox + dx, oy + dy), i = sm(b.x + dx, b.y + dy);
        buf[i] = buf[j]; buf[i + 1] = buf[j + 1]; buf[i + 2] = buf[j + 2];
        stamp(i);
      }
    }
  });

  /* geometry: they rearrange the page under the lens */
  fx('mirror', false, { axis: 'horizontal' }, 'Reflects one half of the lens onto the other. --axis: horizontal, vertical or both.', p => {
    const ax = String(p.axis);
    warp((x, y, d, ux, uy) => sm(ax === 'vertical' ? x : P.x - Math.abs(ux), ax === 'horizontal' ? y : P.y - Math.abs(uy)));
  });
  fx('kaleido', false, { folds: 6, spin: .3 }, 'A turning kaleidoscope.', p => {
    const seg = TAU / clamp(Math.round(p.folds), 2, 32);
    warp((x, y, d, ux, uy) => {
      const r = Math.hypot(ux, uy);
      let a = mod(Math.atan2(uy, ux) + t * p.spin, seg);
      if (a > seg / 2) a = seg - a;
      return sm(P.x + Math.cos(a) * r, P.y + Math.sin(a) * r);
    });
  });
  fx('fold', false, { folds: 4, spin: .15 }, 'Folds the page along turning creases, like paper.', p => {
    const n = clamp(Math.round(p.folds), 1, 12), cx = [], cy = [];
    for (let k = 0; k < n; k++) { const a = t * p.spin + k * 2.39996; cx.push(Math.cos(a)); cy.push(Math.sin(a)); }
    warp((x, y, d, ux, uy) => {
      let a = ux, b = uy;
      for (let k = 0; k < n; k++) { const dd = a * cx[k] + b * cy[k]; if (dd < 0) { a -= 2 * dd * cx[k]; b -= 2 * dd * cy[k]; } }
      return sm(P.x + a, P.y + b);
    });
  });
  fx('droste', false, { ratio: .45, speed: .25 }, 'The lens contains itself forever, zooming inward.', p => {
    const R0 = rad(), lr = Math.log(clamp(p.ratio, .1, .9));
    warp((x, y, d, ux, uy) => {
      const r = Math.hypot(ux, uy);
      if (r < .5) return sm(P.x, P.y);
      const rr = R0 * Math.exp(lr * mod(Math.log(r / R0) / lr + t * p.speed, 1));
      return sm(P.x + ux / r * rr, P.y + uy / r * rr);
    });
  });
  fx('inversion', false, { power: 1 }, 'Circle inversion: everything outside the lens folds inside it.', p => {
    const R0 = rad();
    warp((x, y, d, ux, uy) => { const k = Math.pow(R0 * R0 / (ux * ux + uy * uy || 1), p.power); return sm(P.x + ux * k, P.y + uy * k); });
  });
  const hilCache = {};
  const hil = n => {
    if (hilCache[n]) return hilCache[n];
    const xs = new Uint16Array(n * n), ys = new Uint16Array(n * n);
    for (let d = 0; d < n * n; d++) {
      let x = 0, y = 0, q = d;
      for (let s = 1; s < n; s *= 2) {
        const rx = 1 & (q / 2), ry = 1 & (q ^ rx);
        if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } const tt = x; x = y; y = tt; }
        x += s * rx; y += s * ry; q = Math.floor(q / 4);
      }
      xs[d] = x; ys[d] = y;
    }
    return hilCache[n] = { xs, ys };
  };
  fx('hilbert', true, { shift: 3 }, 'Pixels crawl along a Hilbert space-filling curve. Speed makes them crawl faster.', p => {
    let n = 8;
    while (n * 2 <= 2 * rad() && n < 256) n *= 2;
    const { xs, ys } = hil(n), x0 = Math.round(P.x - n / 2), y0 = Math.round(P.y - n / 2), nn = n * n;
    const k = mod(Math.round(p.shift + P.speed * 2), nn);
    snapRows(y0 - 1, y0 + n + 1);
    for (let d = 0; d < nn; d++) {
      const s = (d - k + nn) % nn;
      put(sm(x0 + xs[d], y0 + ys[d]), sm(x0 + xs[s], y0 + ys[s]));
    }
  });
  fx('brick', false, { size: 7, ratio: .8 }, 'Offset-row pixelation, like a brick wall.', p => {
    const s = Math.max(3, p.size), h = s * p.ratio;
    warp((x, y) => {
      const row = Math.floor(y / h), off = (row & 1) * s / 2;
      return sm(Math.floor((x - off) / s) * s + off + s / 2, row * h + h / 2);
    });
  });
  fx('quadtree', false, { detail: 18, min: 3 }, 'Splits the lens into quarters wherever it is busy and flattens it wherever it is calm.', p => {
    const [bx0, by0, bx1, by1] = lbox(), mn = Math.max(1, p.min);
    const rec = (ax, ay, bx, by) => {
      const w = bx - ax, h = by - ay;
      if (w < 1 || h < 1) return;
      let s = 0, s2 = 0, r = 0, g = 0, b = 0, n = 0;
      for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) {
        const i = idx(x, y), l = lum(i); s += l; s2 += l * l; r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
      }
      const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      if (sd > p.detail && w > mn * 2 && h > mn * 2) {
        const mx = (ax + bx) >> 1, my = (ay + by) >> 1;
        rec(ax, ay, mx, my); rec(mx, ay, bx, my); rec(ax, my, mx, by); rec(mx, my, bx, by);
        return;
      }
      const c = [r / n, g / n, b / n], e = [c[0] * .55, c[1] * .55, c[2] * .55];
      for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) if (inL(x, y)) setc(idx(x, y), x === ax || y === ay ? e : c);
    };
    rec(bx0, by0, bx1, by1);
  });
  fx('tectonic', true, { size: 48, drift: .6 }, 'The page cracks into Voronoi plates that each slide their own way.', p => {
    snap();
    const s = Math.max(8, p.size);
    lens((i, x, y) => {
      const gx = Math.floor(x / s), gy = Math.floor(y / s);
      let bd = 1e9, px = 0, py = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const cx = gx + ox, cy = gy + oy, sx = (cx + hash(cx, cy)) * s, sy = (cy + hash(cy + 17, cx)) * s, d = (sx - x) ** 2 + (sy - y) ** 2;
        if (d < bd) { bd = d; px = cx; py = cy; }
      }
      const a = hash(px * 3.1, py * 7.7) * TAU;
      put(i, sm(x - Math.cos(a) * p.drift, y - Math.sin(a) * p.drift));
    });
  });
  fx('mosh', true, { block: 12, hold: .6 }, 'Datamosh: blocks follow your motion vectors and some never refresh.', p => {
    if (P.speed < .3) return;
    snap();
    const b = clamp(Math.round(p.block), 4, 48), mvx = P.vx * 3, mvy = P.vy * 3;
    cells(b, (x0, y0, ex, ey) => {
      if (Math.random() < p.hold) return;
      for (let y = y0; y < ey; y++) for (let x = x0; x < ex; x++) put(idx(x, y), sm(x - mvx, y - mvy));
    });
  });

  /* signal: they measure the page and redraw it */
  fx('feedback', true, { zoom: .93, turn: .05 }, 'Recursive zoom that leaves a tunnel behind.', p => {
    snap();
    const c = Math.cos(p.turn), s = Math.sin(p.turn);
    lens((i, x, y, d, ux, uy) => mixPut(i, sm(P.x + (ux * c - uy * s) * p.zoom, P.y + (ux * s + uy * c) * p.zoom), .85 * (1 - d ** 4)));
  });
  fx('halo', false, { spacing: 5, rings: 5 }, 'A distance field around every piece of ink, drawn as contour rings.', p => {
    const [x0, y0, x1, y1] = lbox(), w = x1 - x0, h = y1 - y0;
    if (w < 2 || h < 2) return;
    const D = st('halo', () => ({ a: new Float32Array(0) }));
    if (D.a.length < w * h) D.a = new Float32Array(w * h);
    const d = D.a, ink = INK, sp = Math.max(2, p.spacing), mx = sp * Math.max(1, p.rings);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = dk(lum(idx(x0 + x, y0 + y))) < 170 ? 0 : 1e9;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x; let v = d[k];
      if (x > 0) v = Math.min(v, d[k - 1] + 1);
      if (y > 0) { v = Math.min(v, d[k - w] + 1); if (x > 0) v = Math.min(v, d[k - w - 1] + 1.414); if (x < w - 1) v = Math.min(v, d[k - w + 1] + 1.414); }
      d[k] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const k = y * w + x; let v = d[k];
      if (x < w - 1) v = Math.min(v, d[k + 1] + 1);
      if (y < h - 1) { v = Math.min(v, d[k + w] + 1); if (x < w - 1) v = Math.min(v, d[k + w + 1] + 1.414); if (x > 0) v = Math.min(v, d[k + w - 1] + 1.414); }
      d[k] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = d[y * w + x];
      if (v > 0 && v < mx && v % sp < 1 && inL(x0 + x, y0 + y)) mixc(idx(x0 + x, y0 + y), ink, 1 - v / mx * .7);
    }
  });
  const DCT = new Float32Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) DCT[u * 8 + x] = (u ? .5 : Math.SQRT1_2 * .5) * Math.cos((2 * x + 1) * u * Math.PI / 16);
  const blk = new Float32Array(64), co = new Float32Array(64), mid = new Float32Array(64);
  /* ---- strips, layers, blocks and stamps ---- */
  fx('slide', true, { strips: 10, stretch: .6 }, 'Cuts the lens into strips that slide-stretch at different rates along your motion.', p => {
    snap();
    const horiz = Math.abs(P.vx) >= Math.abs(P.vy), s = Math.max(2, p.strips);
    lens((i, x, y, d, ux, uy) => {
      const k = 1 - p.stretch * .1 * hash(Math.floor((horiz ? y : x) / s), 3.7);
      put(i, horiz ? sm(P.x + ux * k, y) : sm(x, P.y + uy * k));
    });
  });
  fx('sift', false, { layers: 3, depth: 3 }, 'Interleaves the page into layers that slide apart with your motion, for pseudo-3D interference.', p => {
    snap();
    const n = clamp(Math.round(p.layers), 2, 8), ox = P.vx * p.depth + 1.5, oy = P.vy * p.depth;
    lens((i, x, y) => { const l = (y % n) - (n - 1) / 2; put(i, sm(x - ox * l, y - oy * l)); });
  });
  fx('collapse', false, { block: 10 }, 'Ranks the blocks in the lens by brightness and repacks them in order.', p => {
    snap();
    const b = clamp(Math.round(p.block), 3, 40), list = [];
    cells(b, (x0, y0, ex, ey, bx, by) => {
      if (ex - x0 < b || ey - y0 < b) return;
      let s = 0;
      for (let y = 0; y < b; y++) for (let x = 0; x < b; x++) s += dk(lumT(idx(bx + x, by + y)));
      list.push({ bx, by, l: s });
    });
    const order = list.slice().sort((a, c) => a.l - c.l);
    list.forEach((dst, k) => {
      const src = order[k];
      for (let y = 0; y < b; y++) for (let x = 0; x < b; x++) put(idx(dst.bx + x, dst.by + y), idx(src.bx + x, src.by + y));
    });
  });
  fx('grain', true, { rate: .25 }, 'Progressive pixelation: the longer you stay, the coarser the page gets.', p => {
    const s = [2, 4, 8, 16][Math.random() * 4 | 0];
    cells(s, (x0, y0, ex, ey) => { if (Math.random() < p.rate) fill(x0, y0, ex, ey, avg(x0, y0, ex, ey)); });
  });
  fx('stamp', true, { hold: 20 }, 'Hold still to pick up what is under the lens, then move to print it in a trail.', p => {
    const s = st('stamp', () => ({ still: 0, patch: null, lx: -1e9, ly: -1e9 }));
    if (P.speed < .25) {
      if (++s.still === Math.max(2, Math.round(p.hold))) {
        const [x0, y0, x1, y1] = lbox(), w = x1 - x0, h = y1 - y0, a = new Uint8ClampedArray(w * h * 4), m = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const k = y * w + x, i = idx(x0 + x, y0 + y);
          a[k * 4] = buf[i]; a[k * 4 + 1] = buf[i + 1]; a[k * 4 + 2] = buf[i + 2];
          m[k] = inL(x0 + x, y0 + y) ? 1 : 0;
        }
        s.patch = { a, m, w, h, ox: x0 - P.x, oy: y0 - P.y };
        s.lx = P.x; s.ly = P.y;
      }
    } else s.still = 0;
    if (!s.patch || Math.hypot(P.x - s.lx, P.y - s.ly) < rad() * .9) return;
    s.lx = P.x; s.ly = P.y;
    const { a, m, w, h, ox, oy } = s.patch, x0 = Math.round(P.x + ox), y0 = Math.round(P.y + oy);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x, X = x0 + x, Y = y0 + y;
      if (!m[k] || X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const i = idx(X, Y);
      buf[i] = a[k * 4]; buf[i + 1] = a[k * 4 + 1]; buf[i + 2] = a[k * 4 + 2];
    }
  });
  /* ---- engraving and line drawing ---- */
  fx('ridges', false, { lines: 22, height: 14 }, 'Ridgelines: the page’s tone lifts each line, and nearer lines hide the ones behind.', p => {
    snap();
    const [x0, y0, x1, y1] = lbox(), n = clamp(Math.round(p.lines), 4, 80), sp = (y1 - y0) / n, tops = new Array(n).fill(null);
    lens(i => setc(i, PAPER));
    for (let x = x0; x < x1; x++) for (let j = 0; j < n; j++) {
      const yb = y0 + (j + .5) * sp;
      const l = (lumT(sm(x - 1, yb)) + lumT(sm(x, yb)) + lumT(sm(x + 1, yb))) / 3;
      const top = Math.round(yb - (1 - dk(l) / 255) * p.height);
      for (let y = top + 1; y <= Math.round(yb) + 1; y++) if (y >= y0 && y < y1 && inL(x, y)) setc(idx(x, y), PAPER);
      const from = tops[j] == null ? top : tops[j];
      for (let y = Math.min(from, top); y <= Math.max(from, top); y++) if (y >= y0 && y < y1 && inL(x, y)) setc(idx(x, y), INK);
      tops[j] = top;
    }
  });
  /* ---- hand and growth ---- */
  fx('scribble', false, { pens: 4, steps: 120 }, 'Pens wander toward the page’s dark areas and redraw it as one continuous line.', p => {
    const s = st('scribble', () => ({ pens: [] }));
    const n = clamp(Math.round(p.pens), 1, 20);
    while (s.pens.length < n) s.pens.push({ x: P.x, y: P.y, a: Math.random() * TAU });
    s.pens.length = n;
    for (const q of s.pens) for (let k = 0; k < p.steps; k++) {
      if (!inL(q.x, q.y)) q.a = Math.atan2(P.y - q.y, P.x - q.x);
      let best = q.a, bv = -1;
      for (const da of [-.5, 0, .5]) {
        const a = q.a + da + (Math.random() - .5) * .6;
        const v = 255 - dk(lumP(sm(q.x + Math.cos(a) * 4, q.y + Math.sin(a) * 4))) + Math.random() * 60;
        if (v > bv) { bv = v; best = a; }
      }
      q.a = best; q.x += Math.cos(q.a); q.y += Math.sin(q.a);
      const i = sm(q.x, q.y); setc(i, INK); stamp(i);
    }
  });
  fx('roots', false, { growth: 40, branch: .03 }, 'Roots grow down from the page’s ink and split as they go.', p => {
    const s = st('roots', () => ({ tips: [] }));
    for (let k = 0; k < 40 && s.tips.length < 300; k++) {
      const x = P.x + (Math.random() * 2 - 1) * P.hw, y = P.y + (Math.random() * 2 - 1) * P.hh;
      if (inL(x, y) && dk(lum(sm(x, y))) < 160) s.tips.push({ x, y, a: Math.PI / 2 + (Math.random() - .5), life: 80 + Math.random() * 120 });
    }
    const born = [], steps = Math.max(1, Math.ceil(p.growth / 10));
    for (const q of s.tips) for (let k = 0; k < steps && q.life > 0; k++) {
      q.a += (Math.random() - .5) * .3 + (Math.PI / 2 - q.a) * .02;
      q.x += Math.cos(q.a) * .8; q.y += Math.sin(q.a) * .8; q.life--;
      const i = sm(q.x, q.y); setc(i, INK); stamp(i);
      if (Math.random() < p.branch && s.tips.length + born.length < 300) born.push({ x: q.x, y: q.y, a: q.a + (Math.random() < .5 ? -.6 : .6), life: q.life * .7 });
    }
    s.tips = s.tips.filter(q => q.life > 0 && q.x >= 0 && q.y >= 0 && q.x < W && q.y < H).concat(born);
  });
  fx('rain', false, { drops: 3, speed: 3 }, 'Drops run down the page and drag the ink with them, like a window in the rain.', p => {
    const s = st('rain', () => ({ d: [] }));
    for (let k = 0; k < p.drops; k++) s.d.push({ x: P.x + (Math.random() * 2 - 1) * P.hw, y: P.y - P.hh + Math.random() * P.hh, life: 60 + Math.random() * 120 });
    for (const q of s.d) for (let k = 0; k < p.speed && q.life > 0; k++) {
      if (Math.random() < .1) q.x += Math.random() < .5 ? -1 : 1;
      for (let w = 0; w < 2; w++) {
        const a = sm(q.x + w, q.y - 2), i = sm(q.x + w, q.y);
        for (let c = 0; c < 3; c++) buf[i + c] = buf[i + c] * .35 + buf[a + c] * .65;
        stamp(i);
      }
      q.y += 1; q.life--;
    }
    s.d = s.d.filter(q => q.life > 0 && q.y < H - 2).slice(-400);
  });

  /* ---- playful objects ---- */
  fx('loupe', false, { zoom: 6 }, 'A pixel loupe: the page under the cursor, magnified with its pixel grid.', p => {
    snap();
    const z = Math.max(2, Math.round(p.zoom)), gc = DARK ? [44, 42, 56] : [222, 220, 230];
    lens((i, x, y, d, ux, uy) => {
      if (mod(ux, z) < 1 || mod(uy, z) < 1) { setc(i, gc); return; }
      put(i, sm(P.x + Math.floor(ux / z), P.y + Math.floor(uy / z)));
    });
  });

  /* ---- oscillators and feedback ---- */
  fx('osc', false, { period: 8, speed: 1, warp: 6, angle: 0 }, 'An oscillator of stripes whose phase is bent by the page underneath.', p => {
    const f = TAU / Math.max(2, p.period), c = Math.cos(p.angle), s = Math.sin(p.angle);
    lens((i, x, y, d, ux, uy) => {
      const v = Math.sin((ux * c + uy * s) * f + t * p.speed * 2 + (1 - dk(lum(i)) / 255) * p.warp);
      setc(i, v > 0 ? INK : PAPER);
    });
  });
  fx('pulse', false, { depth: .15, rings: 18, speed: 4 }, 'The lens breathes: zoom rises and falls in rings.', p => {
    warp((x, y, d, ux, uy) => {
      const k = 1 + p.depth * Math.sin(Math.hypot(ux, uy) * TAU / Math.max(2, p.rings) - t * p.speed);
      return sm(P.x + ux * k, P.y + uy * k);
    });
  });
  fx('scroll', false, { x: 1, y: 0 }, 'The page scrolls endlessly inside the lens.', p => {
    const ox = t * p.x * 30, oy = t * p.y * 30;
    warp((x, y, d, ux, uy) => sm(P.x - P.hw + mod(ux + P.hw - ox, 2 * P.hw), P.y - P.hh + mod(uy + P.hh - oy, 2 * P.hh)));
  });
  fx('diff', true, { scale: 1.03, gain: 3 }, 'Feedback through difference: the page minus a slightly larger copy of itself, frame after frame.', p => {
    snap();
    lens((i, x, y, d, ux, uy) => {
      const j = sm(P.x + ux / p.scale, P.y + uy / p.scale);
      const v = Math.min(1, Math.abs(lumT(i) - lumT(j)) * p.gain / 255);
      for (let c = 0; c < 3; c++) buf[i + c] = PAPER[c] + (INK[c] - PAPER[c]) * v;
    });
  });
  fx('dissolve', false, { scale: .05, speed: .5 }, 'The page dissolves into paper along flowing noise contours.', p => {
    const s = p.scale, th = .5 + .25 * Math.sin(t * p.speed);
    lens((i, x, y) => {
      const n = vn(x * s + t * p.speed, y * s);
      if (Math.abs(n - th) < .015) setc(i, INK);
      else if (n > th) setc(i, PAPER);
    });
  });
  /* ---- more from the others ---- */
  fx('tear', true, { pull: 1.2, rough: 4 }, 'Rips the page along your path and pulls the two edges apart.', p => {
    if (P.speed < .5) return;
    snap();
    const m = Math.hypot(P.vx, P.vy), nx = -P.vy / m, ny = P.vx / m, under = DARK ? [0, 0, 0] : INK;
    lens((i, x, y, d, ux, uy) => {
      const along = ux * ny - uy * nx;
      const sd = ux * nx + uy * ny + (vn(along * .3 + P.x * .3, P.y * .3) - .5) * p.rough;
      if (Math.abs(sd) < 1) { setc(i, under); return; }
      const k = Math.sign(sd) * p.pull * (1 - d);
      put(i, sm(x - nx * k, y - ny * k));
    });
  });
  /* ---- more life: growth, circuits, colonies ---- */
  fx('lichen', false, { rate: 80, cell: 2 }, 'Eden growth: a crust spreads one random edge cell at a time from the page’s ink.', p => {
    const G = cellSize(p.cell);
    const g = st('lichen' + G, () => { const g = makeGrid(G, { a: Uint8Array, shade: Float32Array }); g.list = []; return g; });
    const add = (k, x, y) => { g.a[k] = 1; g.shade[k] = .45 + hash(x, y) * .55; g.list.push(k); touchCell(g, x, y); };
    lensCells(g, (k, x, y) => { if (!g.a[k] && inkAt(g, x, y) && Math.random() < .05) add(k, x, y); });
    const gw = g.gw;
    for (let r = 0; r < p.rate && g.list.length && g.list.length < 80000; r++) {
      const k = g.list[Math.random() * g.list.length | 0], x = k % gw, y = k / gw | 0, d = Math.random() * 4 | 0;
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= gw || ny >= g.gh) continue;
      const q = ny * gw + nx;
      if (!g.a[q]) add(q, nx, ny);
    }
    for (const k of g.list) paintCell(g, k % gw, k / gw | 0, INK, g.shade[k]);
  });
  fx('mycelium', false, { tips: 40, branch: .02 }, 'Fungal threads branch out from the page’s ink and steer away from their own growth.', p => {
    const G = 2;
    const g = st('myc', () => { const g = makeGrid(G, { a: Uint8Array }); g.tips = []; g.cells = []; return g; });
    const gw = g.gw, max = clamp(Math.round(p.tips), 1, 400);
    for (let k = 0; k < 20 && g.tips.length < max; k++) {
      const x = P.x + (Math.random() * 2 - 1) * P.hw, y = P.y + (Math.random() * 2 - 1) * P.hh;
      if (inL(x, y) && dk(lumP(sm(x, y))) < 180) g.tips.push({ x, y, a: Math.random() * TAU, life: 300 });
    }
    const occ = (x, y) => { const cx = x / G | 0, cy = y / G | 0; return cx < 0 || cy < 0 || cx >= gw || cy >= g.gh ? 1 : g.a[cy * gw + cx]; };
    const born = [];
    for (const q of g.tips) for (let s = 0; s < 3 && q.life > 0; s++) {
      q.a += (Math.random() - .5) * .35;
      const ahead = occ(q.x + Math.cos(q.a) * 4, q.y + Math.sin(q.a) * 4);
      if (ahead) q.a += (Math.random() < .5 ? -1 : 1) * .8;
      q.x += Math.cos(q.a); q.y += Math.sin(q.a); q.life--;
      const cx = q.x / G | 0, cy = q.y / G | 0;
      if (cx < 0 || cy < 0 || cx >= gw || cy >= g.gh) { q.life = 0; break; }
      const k = cy * gw + cx;
      if (!g.a[k]) { g.a[k] = 1; g.cells.push(k); }
      if (Math.random() < p.branch && g.tips.length + born.length < max * 4) born.push({ x: q.x, y: q.y, a: q.a + (Math.random() < .5 ? -.9 : .9), life: q.life * .8 });
    }
    g.tips = g.tips.filter(q => q.life > 0).concat(born);
    if (g.cells.length > 120000) { for (const k of g.cells.splice(0, 20000)) g.a[k] = 0; }
    for (const k of g.cells) paintCell(g, k % gw, k / gw | 0, INK, .8);
  });
  fx('wireworld', false, { sparks: 3, cell: 2 }, 'Wireworld: the page’s ink becomes circuitry and your cursor fires electrons into it.', p => {
    const G = cellSize(p.cell);
    const g = st('wire' + G, () => makeGrid(G, { a: Uint8Array, b: Uint8Array }));
    const gw = g.gw;
    touch(g, 2);
    eachCell(g, (k, x, y) => { if (g.a[k] === 0 && inkAt(g, x, y)) g.a[k] = 3; });
    const wires = [];
    lensCells(g, k => { if (g.a[k] === 3) wires.push(k); });
    for (let s = 0; s < p.sparks && wires.length; s++) g.a[wires[Math.random() * wires.length | 0]] = 1;
    eachCell(g, k => {
      const a = g.a, v = a[k];
      if (v === 1) g.b[k] = 2;
      else if (v === 2) g.b[k] = 3;
      else if (v === 3) {
        const n = (a[k - gw - 1] === 1) + (a[k - gw] === 1) + (a[k - gw + 1] === 1) + (a[k - 1] === 1) + (a[k + 1] === 1)
          + (a[k + gw - 1] === 1) + (a[k + gw] === 1) + (a[k + gw + 1] === 1);
        g.b[k] = n === 1 || n === 2 ? 1 : 3;
      } else g.b[k] = 0;
    }, true);
    copyBack(g, g.b, g.a);
    const tail = tint(.45);
    eachCell(g, (k, x, y) => { const v = g.a[k]; if (v === 1) paintCell(g, x, y, PAPER, 1); else if (v === 2) paintCell(g, x, y, tail, 1); });
  });
  fx('excite', false, { states: 10, threshold: 2, cell: 3 }, 'An excitable medium: waves and spirals ripple out from the cursor and part around the page’s ink.', p => {
    const G = cellSize(p.cell), n = clamp(Math.round(p.states), 3, 30);
    const g = st('exc' + G, () => makeGrid(G, { a: Uint8Array, b: Uint8Array }));
    const gw = g.gw, th = Math.max(1, Math.round(p.threshold));
    touch(g, 4);
    if (P.speed > .3) lensCells(g, (k, x, y) => { if (!g.a[k] && !inkAt(g, x, y) && Math.random() < .02) g.a[k] = 1; });
    eachCell(g, (k, x, y) => {
      const a = g.a, v = a[k];
      if (v === 0) {
        if (inkAt(g, x, y)) { g.b[k] = 0; return; }
        const c = (a[k - gw - 1] === 1) + (a[k - gw] === 1) + (a[k - gw + 1] === 1) + (a[k - 1] === 1) + (a[k + 1] === 1)
          + (a[k + gw - 1] === 1) + (a[k + gw] === 1) + (a[k + gw + 1] === 1);
        g.b[k] = c >= th ? 1 : 0;
      } else g.b[k] = v + 1 >= n ? 0 : v + 1;
    }, true);
    copyBack(g, g.b, g.a);
    eachCell(g, (k, x, y) => { const v = g.a[k]; if (v) paintCell(g, x, y, INK, v === 1 ? 1 : (1 - v / n) * .5); });
  });
  fx('worms', false, { count: 6, length: 40 }, 'Worms that seek out ink, eat it, and grow longer as they go.', p => {
    const s = st('worms', () => ({ w: [] }));
    const n = clamp(Math.round(p.count), 1, 40);
    while (s.w.length < n) s.w.push({ x: P.x, y: P.y, a: Math.random() * TAU, body: [], len: 10 });
    s.w.length = n;
    for (const w of s.w) {
      let best = w.a, bv = -1;
      for (const da of [-.6, -.3, 0, .3, .6]) {
        const a = w.a + da, v = 255 - dk(lumP(sm(w.x + Math.cos(a) * 6, w.y + Math.sin(a) * 6))) + Math.random() * 40;
        if (v > bv) { bv = v; best = a; }
      }
      const toC = Math.atan2(P.y - w.y, P.x - w.x), far = Math.hypot(P.x - w.x, P.y - w.y) > rad() * 2;
      w.a = best + (far ? Math.sin(toC - best) * .2 : 0);
      w.x = clamp(w.x + Math.cos(w.a) * 1.5, 0, W - 1); w.y = clamp(w.y + Math.sin(w.a) * 1.5, 0, H - 1);
      const i = sm(w.x, w.y);
      if (dk(lum(i)) < 180) { w.len = Math.min(p.length * 3, w.len + 1); }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = sm(w.x + dx, w.y + dy); setc(j, PAPER); stamp(j); }
      w.body.push([w.x, w.y]);
      while (w.body.length > Math.max(p.length, w.len)) w.body.shift();
    }
    for (const w of s.w) w.body.forEach(([x, y], k) => {
      const r = k > w.body.length - 4 ? 2 : 1;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 1) setc(sm(x + dx, y + dy), INK);
    });
  });
  fx('termites', false, { count: 150, cell: 2 }, 'Resnick’s termites pick up specks of ink and drop them beside other specks, gathering the page into piles.', p => {
    const G = cellSize(p.cell);
    const g = st('term' + G, () => { const g = makeGrid(G, { chip: Uint8Array, seen: Uint8Array }); g.t = []; return g; });
    const gw = g.gw;
    lensCells(g, (k, x, y) => { if (!g.seen[k]) { g.seen[k] = 1; g.chip[k] = inkAt(g, x, y) ? 1 : 0; touchCell(g, x, y); } });
    const n = clamp(Math.round(p.count), 1, 2000);
    while (g.t.length < n) g.t.push({ x: Math.floor(P.x / G), y: Math.floor(P.y / G), c: 0 });
    g.t.length = n;
    for (const q of g.t) for (let s = 0; s < 4; s++) {
      const d = Math.random() * 4 | 0, nx = q.x + DX[d], ny = q.y + DY[d];
      if (nx < 0 || ny < 0 || nx >= gw || ny >= g.gh || !g.seen[ny * gw + nx]) continue;
      q.x = nx; q.y = ny;
      const k = ny * gw + nx;
      if (!q.c && g.chip[k]) { g.chip[k] = 0; q.c = 1; }
      else if (q.c && g.chip[k]) {
        for (let e = 0; e < 4; e++) { const ex = nx + DX[e], ey = ny + DY[e], ek = ey * gw + ex; if (ex >= 0 && ey >= 0 && ex < gw && ey < g.gh && g.seen[ek] && !g.chip[ek]) { g.chip[ek] = 1; q.c = 0; break; } }
      }
    }
    eachCell(g, (k, x, y) => { if (g.seen[k]) paintCell(g, x, y, g.chip[k] ? INK : PAPER, 1); });
    for (const q of g.t) if (q.c) paintCell(g, q.x, q.y, INK, .6);
  });
  fx('wildfire', false, { grow: .004, spread: .8, cell: 3 }, 'A forest grows on the paper, your cursor sets it alight, and the page’s ink works as firebreaks.', p => {
    const G = cellSize(p.cell);
    const g = st('fire' + G, () => makeGrid(G, { a: Uint8Array, b: Uint8Array, seen: Uint8Array }));
    const gw = g.gw;
    lensCells(g, (k, x, y) => {
      if (!g.seen[k]) { g.seen[k] = 1; g.a[k] = inkAt(g, x, y) ? 4 : Math.random() < .6 ? 1 : 0; touchCell(g, x, y); }
      else if (g.a[k] === 1 && P.speed > 1.5 && Math.random() < .02) g.a[k] = 2;
    });
    eachCell(g, k => {
      const a = g.a, v = a[k];
      if (!g.seen[k] || v === 4) { g.b[k] = v; return; }
      if (v === 2) { g.b[k] = 3; return; }
      if (v === 1) {
        const burning = a[k - 1] === 2 || a[k + 1] === 2 || a[k - gw] === 2 || a[k + gw] === 2;
        g.b[k] = burning && Math.random() < p.spread ? 2 : 1;
        return;
      }
      g.b[k] = Math.random() < p.grow ? 1 : v;
    }, true);
    copyBack(g, g.b, g.a);
    const tree = tint(.22), ash = tint(.06);
    eachCell(g, (k, x, y) => { const v = g.a[k]; if (!g.seen[k] || v === 4 || v === 0) return; paintCell(g, x, y, v === 2 ? INK : v === 1 ? tree : ash, 1); });
  });
  fx('ivy', false, { vines: 20, leaf: .04 }, 'Vines that climb along the edges of the page’s ink, putting out leaves.', p => {
    const s = st('ivy', () => ({ v: [] }));
    const n = clamp(Math.round(p.vines), 1, 200);
    for (let k = 0; k < 30 && s.v.length < n; k++) {
      const x = P.x + (Math.random() * 2 - 1) * P.hw, y = P.y + (Math.random() * 2 - 1) * P.hh;
      if (inL(x, y) && dk(lumP(sm(x, y))) > 200) s.v.push({ x, y, a: Math.random() * TAU, life: 260 });
    }
    const edge = (x, y) => {
      if (dk(lumP(sm(x, y))) < 200) return -1;
      let c = 0;
      for (let q = 0; q < 4; q++) if (dk(lumP(sm(x + DX[q] * 2, y + DY[q] * 2))) < 200) c++;
      return c;
    };
    for (const q of s.v) for (let k = 0; k < 4 && q.life > 0; k++) {
      let best = q.a, bv = -2;
      for (const da of [-.7, -.35, 0, .35, .7]) {
        const a = q.a + da, v = edge(q.x + Math.cos(a) * 2, q.y + Math.sin(a) * 2) + Math.random() * .6;
        if (v > bv) { bv = v; best = a; }
      }
      q.a = best; q.x += Math.cos(q.a); q.y += Math.sin(q.a); q.life--;
      const i = sm(q.x, q.y); setc(i, INK); stamp(i);
      if (Math.random() < p.leaf) {
        const la = q.a + (Math.random() < .5 ? 1.4 : -1.4);
        for (let r = 1; r < 5; r++) for (let w = -1; w <= 1; w++) {
          const j = sm(q.x + Math.cos(la) * r - Math.sin(la) * w * (r < 4 ? 1 : 0), q.y + Math.sin(la) * r + Math.cos(la) * w * (r < 4 ? 1 : 0));
          setc(j, INK); stamp(j);
        }
      }
    }
    s.v = s.v.filter(q => q.life > 0 && q.x > 0 && q.y > 0 && q.x < W - 1 && q.y < H - 1);
  });

  /* ---- more life: cracks, veins, creatures, decay, plants, weather ---- */
  const inkPx = (x, y) => dk(lumP(sm(x, y))) < 160;
  /* a random spot in the lens that passes test(), or null after many tries */
  const pick = (test, tries = 500) => {
    for (let k = 0; k < tries; k++) {
      const x = Math.round(P.x + (Math.random() * 2 - 1) * P.hw), y = Math.round(P.y + (Math.random() * 2 - 1) * P.hh);
      if (inL(x, y) && test(x, y)) return [x, y];
    }
    return null;
  };
  const line = (ax, ay, bx, by, c, w) => {
    const n = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))) || 1;
    for (let k = 0; k <= n; k++) { const i = sm(ax + (bx - ax) * k / n, ay + (by - ay) * k / n); if (w >= 1) setc(i, c); else mixc(i, c, w); stamp(i); }
  };
  fx('substrate', false, { cracks: 12, speed: 3 }, 'Cracks run straight until they hit something, and new ones split off old ones at right angles.', p => {
    const s = st('substrate', () => ({ ang: new Float32Array(N).fill(1e9), act: [], drawn: [] }));
    const seed = () => {
      if (s.drawn.length && Math.random() < .85) {
        const k = s.drawn[Math.random() * s.drawn.length | 0], a = s.ang[k] + (Math.random() < .5 ? 1 : -1) * Math.PI / 2 + (Math.random() - .5) * .1;
        return { x: k % W + Math.cos(a) * 2, y: (k / W | 0) + Math.sin(a) * 2, a };
      }
      for (let tries = 0; tries < 40; tries++) {
        const x = P.x + (Math.random() * 2 - 1) * P.hw, y = P.y + (Math.random() * 2 - 1) * P.hh;
        if (inL(x, y) && inkPx(x, y)) return { x, y, a: Math.round(Math.random() * 4) * Math.PI / 2 + (Math.random() - .5) * .3 };
      }
      return { x: P.x, y: P.y, a: Math.random() * TAU };
    };
    while (s.act.length < clamp(Math.round(p.cracks), 1, 80)) s.act.push(seed());
    for (let c = 0; c < s.act.length; c++) {
      const q = s.act[c];
      for (let k = 0; k < p.speed * 3; k++) {
        q.x += Math.cos(q.a) * .5; q.y += Math.sin(q.a) * .5;
        const x = Math.round(q.x), y = Math.round(q.y);
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) { s.act[c] = seed(); break; }
        const kk = y * W + x, prev = s.ang[kk];
        if ((prev < 1e8 && Math.abs(prev - q.a) > .05) || (inkPx(x, y) && Math.random() < .3 && s.drawn.length > 20)) { s.act[c] = seed(); break; }
        s.ang[kk] = q.a;
        if (prev > 1e8) s.drawn.push(kk);
        const i = kk * 4; setc(i, INK); stamp(i);
        const sd = Math.random() * 6;
        mixc(sm(q.x - Math.sin(q.a) * sd, q.y + Math.cos(q.a) * sd), INK, .08); stamp(sm(q.x - Math.sin(q.a) * sd, q.y + Math.cos(q.a) * sd));
      }
    }
    if (s.drawn.length > 200000) s.drawn.splice(0, 50000);
  });
  fx('veins', false, { auxins: 160, step: 2 }, 'Space colonization: veins grow out of the page’s ink toward scattered sources, branching like a leaf.', p => {
    const s = st('veins', () => ({ aux: [], nodes: [] }));
    for (let k = 0; k < 3 && s.nodes.length < 6000; k++) { const q = pick(inkPx, 200); if (q) s.nodes.push({ x: q[0], y: q[1] }); }
    s.aux = s.aux.filter(a => Math.abs(a.x - P.x) < P.hw * 1.8 && Math.abs(a.y - P.y) < P.hh * 1.8);
    while (s.aux.length < p.auxins) {
      const x = P.x + (Math.random() * 2 - 1) * P.hw * 1.3, y = P.y + (Math.random() * 2 - 1) * P.hh * 1.3;
      s.aux.push({ x, y });
    }
    let near = s.nodes.filter(n => Math.abs(n.x - P.x) < P.hw * 1.6 && Math.abs(n.y - P.y) < P.hh * 1.6);
    if (!near.length) { s.nodes.push({ x: P.x, y: P.y }); near = [s.nodes[s.nodes.length - 1]]; }
    const pull = new Map(), infl = 40 * 40, kill = (p.step * 2) ** 2;
    s.aux = s.aux.filter(a => {
      let best = null, bd = infl;
      for (const n of near) { const d = (n.x - a.x) ** 2 + (n.y - a.y) ** 2; if (d < bd) { bd = d; best = n; } }
      if (best && bd < kill) return false;
      if (best) { const v = pull.get(best) || [0, 0], m = Math.sqrt(bd) || 1; v[0] += (a.x - best.x) / m; v[1] += (a.y - best.y) / m; pull.set(best, v); }
      return Math.random() > .01;
    });
    for (const [n, v] of pull) {
      const m = Math.hypot(v[0], v[1]) || 1, c = { x: n.x + v[0] / m * p.step, y: n.y + v[1] / m * p.step };
      s.nodes.push(c);
      line(n.x, n.y, c.x, c.y, INK, .85);
    }
  });
  fx('bosco', false, { radius: 5, cell: 3 }, 'Larger than Life, Bosco’s rule: a wide-neighbourhood automaton whose blobs crawl like creatures.', p => {
    const G = cellSize(p.cell), Rr = clamp(Math.round(p.radius), 2, 8);
    const g = st('bosco' + G, () => makeGrid(G, { a: Uint8Array, b: Uint8Array }));
    touch(g, Rr + 3);
    if (P.speed > .3) lensCells(g, k => { if (Math.random() < .5) g.a[k] = 1; });
    else lensCells(g, (k, x, y) => { if (inkAt(g, x, y) && Math.random() < .3) g.a[k] = 1; });
    if (fr % 2) {
      const [x0, y0, x1, y1] = g.box, bw = x1 - x0, bh = y1 - y0, sat = new Int32Array((bw + 1) * (bh + 1));
      for (let y = 0; y < bh; y++) { let row = 0; for (let x = 0; x < bw; x++) { row += g.a[(y0 + y) * g.gw + x0 + x]; sat[(y + 1) * (bw + 1) + x + 1] = sat[y * (bw + 1) + x + 1] + row; } }
      const sum = (ax, ay, bx, by) => sat[by * (bw + 1) + bx] - sat[ay * (bw + 1) + bx] - sat[by * (bw + 1) + ax] + sat[ay * (bw + 1) + ax];
      const lo = Math.round(33 * (2 * Rr + 1) ** 2 / 121), hi = Math.round(57 * (2 * Rr + 1) ** 2 / 121), blo = Math.round(34 * (2 * Rr + 1) ** 2 / 121), bhi = Math.round(45 * (2 * Rr + 1) ** 2 / 121);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const c = sum(Math.max(0, x - Rr), Math.max(0, y - Rr), Math.min(bw, x + Rr + 1), Math.min(bh, y + Rr + 1)), k = (y0 + y) * g.gw + x0 + x;
        g.b[k] = g.a[k] ? (c >= lo && c <= hi ? 1 : 0) : (c >= blo && c <= bhi ? 1 : 0);
      }
      copyBack(g, g.b, g.a);
    }
    eachCell(g, (k, x, y) => { if (g.a[k]) paintCell(g, x, y, INK, .85); });
  });
  fx('rot', true, { rate: .2 }, 'The ink rots from its edges: letters crumble a few pixels at a time.', p => {
    snap();
    lens((i, x, y) => {
      if (dk(lumT(i)) > 150 || Math.random() > p.rate) return;
      let open = 0;
      for (let q = 0; q < 4; q++) if (dk(lumT(sm(x + DX[q], y + DY[q]))) > 200) open++;
      if (open) mixc(i, PAPER, .35 + open * .1);
    });
  });
  fx('sprout', false, { seeds: 3, height: 40 }, 'Little plants sprout from the tops of letters and grow upward, leaf by leaf.', p => {
    const s = st('sprout', () => ({ pl: [] }));
    const plant = (x, y) => s.pl.push({ x, y, a: -Math.PI / 2, len: 0, max: p.height * (.5 + Math.random() * .7), side: Math.random() < .5 ? 1 : -1 });
    if (fr % Math.max(1, Math.round(12 / Math.max(.1, p.seeds))) === 0 && s.pl.length < 120) {
      const q = pick((x, y) => inkPx(x, y) && !inkPx(x, y - 1));
      if (q) plant(q[0], q[1] - 1);
      else if (!s.pl.some(q2 => Math.abs(q2.x - P.x) < P.hw && Math.abs(q2.y - P.y) < P.hh * 2)) plant(P.x, P.y + P.hh * .5);
    }
    for (const q of s.pl) {
      if (q.len >= q.max) continue;
      q.a += (Math.random() - .5) * .15 + (-Math.PI / 2 - q.a) * .05;
      q.x += Math.cos(q.a); q.y += Math.sin(q.a); q.len++;
      const i = sm(q.x, q.y); setc(i, INK); stamp(i);
      if (q.len % 7 === 0) {
        q.side = -q.side;
        const la = q.a + q.side * 1.1;
        for (let r = 1; r <= 5; r++) for (let w = -1; w <= 1; w++) {
          if (Math.abs(w) && (r < 2 || r > 4)) continue;
          const j = sm(q.x + Math.cos(la) * r - Math.sin(la) * w, q.y + Math.sin(la) * r + Math.cos(la) * w);
          mixc(j, INK, .7); stamp(j);
        }
      }
      if (q.len >= q.max) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dy * dy <= 4) { const j = sm(q.x + dx, q.y + dy); setc(j, INK); stamp(j); }
    }
    s.pl = s.pl.filter(q => q.len < q.max || Math.random() > .01).slice(-200);
  });
  fx('spark', false, { branches: 3, reach: 1.6 }, 'Lightning arcs from the cursor to the nearest ink and forks on the way.', p => {
    const s = st('spark', () => ({ bolt: null, life: 0 }));
    if (--s.life <= 0) {
      let tx = P.x + (Math.random() - .5) * P.hw * 2, ty = P.y + P.hh, bd = 1e9;
      for (let k = 0; k < 120; k++) {
        const a = Math.random() * TAU, r = rad() * p.reach * Math.sqrt(Math.random()), x = P.x + Math.cos(a) * r, y = P.y + Math.sin(a) * r;
        if (r > rad() * .35 && inkPx(x, y) && r < bd) { bd = r; tx = x; ty = y; }
      }
      const bolt = (ax, ay, bx, by, depth) => {
        const pts = [[ax, ay], [bx, by]];
        let off = Math.hypot(bx - ax, by - ay) * .25;
        for (let it = 0; it < 5; it++) {
          for (let k = pts.length - 1; k > 0; k--) {
            const [x1, y1] = pts[k - 1], [x2, y2] = pts[k], nx = -(y2 - y1), ny = x2 - x1, m = Math.hypot(nx, ny) || 1, o = (Math.random() - .5) * off;
            pts.splice(k, 0, [(x1 + x2) / 2 + nx / m * o, (y1 + y2) / 2 + ny / m * o]);
          }
          off *= .55;
        }
        const out = [pts];
        if (depth < 2) for (let b = 0; b < p.branches; b++) {
          const [sx, sy] = pts[(Math.random() * pts.length * .7) | 0], a = Math.atan2(by - ay, bx - ax) + (Math.random() - .5) * 1.6, l = Math.hypot(bx - ax, by - ay) * (.2 + Math.random() * .3);
          out.push(...bolt(sx, sy, sx + Math.cos(a) * l, sy + Math.sin(a) * l, depth + 1));
        }
        return out;
      };
      s.bolt = bolt(P.x, P.y, tx, ty, 0);
      s.life = 3;
    }
    s.bolt.forEach((pts, b) => {
      for (let k = 1; k < pts.length; k++) {
        const [ax, ay] = pts[k - 1], [bx, by] = pts[k], n = Math.ceil(Math.hypot(bx - ax, by - ay)) || 1;
        for (let q = 0; q <= n; q++) { const x = ax + (bx - ax) * q / n, y = ay + (by - ay) * q / n; setc(sm(x, y), INK); if (!b) setc(sm(x + 1, y), INK); }
      }
    });
  });
  fx('fur', false, { length: 10, density: 3 }, 'Hairs grow along the edges of the ink and sway with your movement.', p => {
    const [x0, y0, x1, y1] = lbox(), g = Math.max(1, Math.round(p.density)), L0 = p.length;
    const wx = -P.vx * .8 + Math.sin(t * 2) * 1.2, wy = -P.vy * .8;
    for (let y = y0 + (fr % g); y < y1; y += g) for (let x = x0 + ((y * 7) % g); x < x1; x += g) {
      if (!inL(x, y)) continue;
      const gx = dk(lumP(sm(x + 1, y))) - dk(lumP(sm(x - 1, y))), gy = dk(lumP(sm(x, y + 1))) - dk(lumP(sm(x, y - 1))), m = Math.hypot(gx, gy);
      if (m < 18 || dk(lumP(sm(x, y))) > dk(lumP(sm(x + gx / m * 2, y + gy / m * 2)))) continue;
      const nx = gx / m, ny = gy / m, len = L0 * (.6 + hash(x, y) * .6);
      for (let s = 1; s <= len; s++) {
        const f = s / len, px = x + nx * s + wx * f * f * len * .25, py = y + ny * s + wy * f * f * len * .25;
        if (inL(px, py)) mixc(sm(px, py), INK, 1 - f * .7);
      }
    }
  });
  fx('frost', false, { growth: 30, branch: .08 }, 'Ice crystals grow off the ink along six directions, branching like frost on glass.', p => {
    const s = st('frost', () => ({ tips: [] }));
    for (let k = 0; k < 3 && s.tips.length < 400; k++) {
      const a = (Math.random() * 6 | 0) * Math.PI / 3, q = pick((x, y) => inkPx(x, y) && !inkPx(x + Math.cos(a) * 2, y + Math.sin(a) * 2), 200);
      if (q) s.tips.push({ x: q[0], y: q[1], a, life: 20 + Math.random() * 40 });
    }
    if (!s.tips.length && fr % 20 === 0) for (let d = 0; d < 6; d++) s.tips.push({ x: P.x, y: P.y, a: d * Math.PI / 3, life: 30 + Math.random() * 30 });
    const born = [], steps = Math.max(1, Math.round(p.growth / 10));
    for (const q of s.tips) for (let k = 0; k < steps && q.life > 0; k++) {
      const nx = q.x + Math.cos(q.a), ny = q.y + Math.sin(q.a);
      if (dk(lum(sm(nx + Math.cos(q.a), ny + Math.sin(q.a)))) < 120 && k > 0) { q.life = 0; break; }
      q.x = nx; q.y = ny; q.life--;
      const i = sm(q.x, q.y); mixc(i, INK, .8); stamp(i);
      if (Math.random() < p.branch && s.tips.length + born.length < 900) born.push({ x: q.x, y: q.y, a: q.a + (Math.random() < .5 ? 1 : -1) * Math.PI / 3, life: q.life * .6 });
    }
    s.tips = s.tips.filter(q => q.life > 0 && q.x > 1 && q.y > 1 && q.x < W - 1 && q.y < H - 1).concat(born);
  });

  /* ---- more life: ecologies, weather, crystals ---- */
  fx('hunt', false, { prey: 120, predators: 10 }, 'Predator and prey: grazers feed on ink, hunters chase them, and both populations rise and crash in waves.', p => {
    const s = st('hunt', () => ({ prey: [], pred: [] }));
    const maxPrey = clamp(Math.round(p.prey), 5, 1000), maxPred = clamp(Math.round(p.predators), 1, 200);
    if (s.prey.length < 8) for (let k = 0; k < 20; k++) { const q = pick(inkPx, 60) || [P.x + (Math.random() * 2 - 1) * P.hw, P.y + (Math.random() * 2 - 1) * P.hh]; s.prey.push({ x: q[0], y: q[1], a: Math.random() * TAU }); }
    if (!s.pred.length && s.prey.length > 15) for (let k = 0; k < 3; k++) s.pred.push({ x: P.x, y: P.y, a: Math.random() * TAU, e: 140 });
    const bounce = q => { if (q.x < 1 || q.x > W - 2) { q.a = Math.PI - q.a; q.x = clamp(q.x, 1, W - 2); } if (q.y < 1 || q.y > H - 2) { q.a = -q.a; q.y = clamp(q.y, 1, H - 2); } };
    const kids = [];
    for (const q of s.prey) {
      let fx2 = 0, fy2 = 0;
      for (const h of s.pred) { const dx = q.x - h.x, dy = q.y - h.y, d2 = dx * dx + dy * dy; if (d2 < 2500) { fx2 += dx / (d2 + 1); fy2 += dy / (d2 + 1); } }
      const fleeing = fx2 || fy2;
      if (fleeing) q.a = Math.atan2(fy2, fx2);
      else { let best = q.a, bv = -1; for (const da of [-.5, 0, .5]) { const a = q.a + da, v = (inkPx(q.x + Math.cos(a) * 4, q.y + Math.sin(a) * 4) ? 1 : 0) + Math.random() * .8; if (v > bv) { bv = v; best = a; } } q.a = best; }
      q.a += (Math.random() - .5) * .4;
      const sp = fleeing ? 1.8 : 1;
      q.x += Math.cos(q.a) * sp; q.y += Math.sin(q.a) * sp; bounce(q);
      const i = sm(q.x, q.y); mixc(i, INK, .18); stamp(i);
      if (s.prey.length + kids.length < maxPrey && Math.random() < (inkPx(q.x, q.y) ? .012 : .002)) kids.push({ x: q.x, y: q.y, a: Math.random() * TAU });
    }
    s.prey.push(...kids);
    const pk = [];
    for (const h of s.pred) {
      let tgt = null, bd = 8100;
      for (const q of s.prey) { const d2 = (q.x - h.x) ** 2 + (q.y - h.y) ** 2; if (d2 < bd) { bd = d2; tgt = q; } }
      if (tgt) h.a = Math.atan2(tgt.y - h.y, tgt.x - h.x) + (Math.random() - .5) * .3; else h.a += (Math.random() - .5) * .5;
      h.x += Math.cos(h.a) * 1.6; h.y += Math.sin(h.a) * 1.6; bounce(h);
      if (tgt && bd < 9) { tgt.dead = true; h.e += 55; }
      h.e -= .45;
      const i = sm(h.x, h.y); mixc(i, INK, .45); stamp(i);
      if (h.e > 220 && s.pred.length + pk.length < maxPred) { h.e /= 2; pk.push({ x: h.x, y: h.y, a: h.a + Math.PI, e: h.e }); }
    }
    s.prey = s.prey.filter(q => !q.dead);
    s.pred = s.pred.filter(h => h.e > 0).concat(pk);
    for (const q of s.prey) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) mixc(sm(q.x + dx, q.y + dy), INK, .55);
    for (const h of s.pred) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) setc(sm(h.x + dx, h.y + dy), INK);
  });
  fx('spores', false, { rate: 6, drift: 1 }, 'Spores ride the wind of your cursor and germinate into small colonies where they land on ink.', p => {
    const s = st('spores', () => ({ sp: [] }));
    for (let k = 0; k < p.rate; k++) s.sp.push({ x: P.x + (Math.random() - .5) * 6, y: P.y + (Math.random() - .5) * 6, vx: P.vx * .6 + (Math.random() - .5) * 1.5, vy: P.vy * .6 + (Math.random() - .5) * 1.5 - .2, life: 60 + Math.random() * 120 });
    for (const q of s.sp) {
      q.vx += (vn(q.x * .02 + t * .2, q.y * .02) - .5) * .3 * p.drift; q.vy += (vn(q.x * .02, q.y * .02 - t * .2) - .5) * .3 * p.drift + .01;
      q.vx *= .96; q.vy *= .96; q.x += q.vx; q.y += q.vy; q.life--;
      if (q.life > 0) { mixc(sm(q.x, q.y), INK, .5); continue; }
      if (!inkPx(q.x, q.y) && Math.random() > .06) continue;
      const r = 1.5 + Math.random() * 3;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > r || Math.random() > .75 - d / r * .4) continue;
        const i = sm(q.x + dx, q.y + dy); mixc(i, INK, .55 + Math.random() * .45); stamp(i);
      }
    }
    s.sp = s.sp.filter(q => q.life > 0 && q.x > 0 && q.y > 0 && q.x < W && q.y < H).slice(-1500);
  });
  fx('hive', false, { size: 7, rate: 6 }, 'Hexagonal comb grows outward from the ink, one cell at a time, wherever you hover.', p => {
    const sz = Math.max(3, p.size), R3 = Math.sqrt(3);
    const s = st('hive' + sz, () => ({ built: new Set(), front: [] }));
    const center = (q, r) => [sz * R3 * (q + r / 2), sz * 1.5 * r];
    const toHex = (x, y) => { const r = Math.round(y / (sz * 1.5)); return [Math.round(x / (sz * R3) - r / 2), r]; };
    const build = (q, r) => {
      const key = q + ',' + r;
      if (s.built.has(key)) return;
      s.built.add(key); s.front.push([q, r]);
      const [cx, cy] = center(q, r);
      for (let c = 0; c < 6; c++) {
        const a1 = Math.PI / 6 + c * Math.PI / 3, a2 = a1 + Math.PI / 3;
        line(cx + Math.cos(a1) * sz, cy + Math.sin(a1) * sz, cx + Math.cos(a2) * sz, cy + Math.sin(a2) * sz, INK, .9);
      }
    };
    for (let k = 0; k < 2; k++) { const at = pick(inkPx, 120); if (at) build(...toHex(at[0], at[1])); }
    if (!s.front.length) build(...toHex(P.x, P.y));
    const N6 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
    for (let k = 0; k < p.rate * 3 && s.front.length; k++) {
      const ix = Math.random() * s.front.length | 0, [q, r] = s.front[ix], [dq, dr] = N6[Math.random() * 6 | 0];
      const [cx, cy] = center(q + dq, r + dr);
      if (cx < 0 || cy < 0 || cx >= W || cy >= H || Math.hypot(cx - P.x, cy - P.y) > rad() * 1.3) { if (Math.random() < .1) s.front.splice(ix, 1); continue; }
      if (!s.built.has((q + dq) + ',' + (r + dr))) build(q + dq, r + dr); else if (Math.random() < .2) s.front.splice(ix, 1);
    }
    if (s.built.size > 40000) { s.built.clear(); s.front.length = 0; }
  });
  fx('fireflies', false, { count: 80, sync: .06 }, 'Fireflies drift over the page and blink. Each flash nudges its neighbours until they fall into step.', p => {
    const s = st('ff', () => ({ f: [] }));
    const n = clamp(Math.round(p.count), 5, 400);
    while (s.f.length < n) s.f.push({ x: P.x + (Math.random() * 2 - 1) * P.hw * 1.5, y: P.y + (Math.random() * 2 - 1) * P.hh * 1.5, ph: Math.random(), fl: 0, vx: 0, vy: 0 });
    s.f.length = n;
    const flashes = [];
    for (const q of s.f) {
      q.ph += .012;
      if (q.ph >= 1) { q.ph = 0; q.fl = 1; flashes.push(q); }
      q.fl *= .86;
      q.vx = (q.vx + (Math.random() - .5) * .1 + (P.x - q.x) * .0004) * .95; q.vy = (q.vy + (Math.random() - .5) * .1 + (P.y - q.y) * .0004) * .95;
      q.x += q.vx; q.y += q.vy;
    }
    for (const a of flashes) for (const q of s.f) if (q !== a && q.ph > 0 && (q.x - a.x) ** 2 + (q.y - a.y) ** 2 < 3600) q.ph = Math.min(1, q.ph + p.sync);
    for (const q of s.f) {
      const r = 1 + q.fl * 3.5, w = .15 + q.fl * .85;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.hypot(dx, dy); if (d <= r) mixc(sm(q.x + dx, q.y + dy), INK, w * (1 - d / (r + 1))); }
    }
  });
  fx('erosion', false, { drops: 20, carry: 4 }, 'Rain carves channels down through the ink and drops the sediment in small deltas below.', p => {
    const s = st('ero', () => ({ d: [] }));
    for (let k = 0; k < p.drops; k++) s.d.push({ x: P.x + (Math.random() * 2 - 1) * P.hw, y: P.y - P.hh * (.3 + Math.random() * .7), load: 0, life: 220 });
    for (const q of s.d) for (let st2 = 0; st2 < 3 && q.life > 0; st2++) {
      let best = 0, bv = -1;
      for (const dx of [-1, 0, 1]) { const v = dk(lum(sm(q.x + dx, q.y + 1))) + Math.random() * 40; if (v > bv) { bv = v; best = dx; } }
      const i = sm(q.x, q.y);
      if (dk(lum(i)) < 200 && q.load < p.carry) { mixc(i, PAPER, .55); stamp(i); q.load++; }
      else if (q.load > 0 && Math.random() < .07) { mixc(i, INK, .6); stamp(i); q.load--; }
      q.x += best; q.y += 1; q.life--;
      if (q.y > P.y + P.hh * 1.4 || q.y >= H - 1) {
        for (; q.load > 0; q.load--) { const j = sm(q.x + (Math.random() - .5) * 8, q.y + Math.random() * 3); mixc(j, INK, .6); stamp(j); }
        q.life = 0;
      }
    }
    s.d = s.d.filter(q => q.life > 0).slice(-600);
  });
  fx('snowflake', false, { size: 40, branch: .12 }, 'Six-fold crystals grow from the cursor, every branch mirrored twelve ways.', p => {
    const s = st('snow', () => ({ flakes: [], last: -1e9 }));
    s.flakes = s.flakes.filter(f => f.tips.length);
    if (fr - s.last > 30 && !s.flakes.some(f => Math.hypot(f.cx - P.x, f.cy - P.y) < p.size * 1.2)) {
      s.flakes.push({ cx: P.x, cy: P.y, tips: [{ x: 0, y: 0, a: 0, life: p.size }] });
      s.last = fr;
      if (s.flakes.length > 40) s.flakes.shift();
    }
    for (const fl of s.flakes) {
      if (!fl.tips.length) continue;
      const born = [];
      for (const q of fl.tips) {
        if (q.life-- <= 0) continue;
        q.x += Math.cos(q.a); q.y += Math.sin(q.a);
        for (let k = 0; k < 6; k++) {
          const r = k * Math.PI / 3, c = Math.cos(r), sn = Math.sin(r);
          for (const m of [1, -1]) { const yy = q.y * m, i = sm(fl.cx + q.x * c - yy * sn, fl.cy + q.x * sn + yy * c); setc(i, INK); stamp(i); }
        }
        if (Math.random() < p.branch && q.life > 3) born.push({ x: q.x, y: q.y, a: q.a === 0 ? Math.PI / 3 : q.a - Math.PI / 3, life: q.life * .55 });
      }
      fl.tips = fl.tips.filter(q => q.life > 0).concat(born);
    }
  });

  /* ---- time ---- */
  const hist = { on: false, n: 24, i: 0, slots: [], w: Math.ceil(W / 2), h: Math.ceil(H / 2) };
  function recordHistory() {
    if (!hist.on || fr % 25) return;
    const slot = hist.slots[hist.i] || (hist.slots[hist.i] = new Uint8ClampedArray(hist.w * hist.h * 3));
    for (let y = 0; y < hist.h; y++) for (let x = 0; x < hist.w; x++) {
      const i = idx(Math.min(W - 1, x * 2), Math.min(H - 1, y * 2)), j = (y * hist.w + x) * 3;
      slot[j] = buf[i]; slot[j + 1] = buf[i + 1]; slot[j + 2] = buf[i + 2];
    }
    hist.i = (hist.i + 1) % hist.n;
  }
  fx('rewind', false, { seconds: 8 }, 'The lens shows the page as it was a few seconds ago. It starts remembering the first time you use it.', p => {
    hist.on = true;
    const back = clamp(Math.round(p.seconds * 60 / 25), 1, hist.n - 1), slot = hist.slots[(hist.i - back + hist.n * 4) % hist.n];
    if (!slot) return;
    lens((i, x, y) => { const j = ((y >> 1) * hist.w + (x >> 1)) * 3; buf[i] = slot[j]; buf[i + 1] = slot[j + 1]; buf[i + 2] = slot[j + 2]; });
  });
  fx('exposure', false, { decay: .985 }, 'A long exposure: the lens keeps everything that has moved under it, like a shutter left open. Put it after something that moves.', p => {
    const s = st('expo', () => ({ a: new Float32Array(N) }));
    lens(i => {
      const k = i >> 2, v = Math.max(s.a[k] * p.decay, 1 - dk(lum(i)) / 255);
      s.a[k] = v;
      for (let c = 0; c < 3; c++) buf[i + c] = PAPER[c] + (INK[c] - PAPER[c]) * v;
    });
  });

  /* ---- print ---- */
  fx('woodcut', false, { width: 6, flow: 1 }, 'Carves the lens into gouged strokes that follow the shapes underneath, like a woodblock print.', p => {
    snap();
    const w = Math.max(3, p.width);
    lens((i, x, y) => {
      const gx = lumT(sm(x + 3, y)) - lumT(sm(x - 3, y)), gy = lumT(sm(x, y + 3)) - lumT(sm(x, y - 3)), m = Math.hypot(gx, gy);
      const nx = m > 8 ? gx / m : .6, ny = m > 8 ? gy / m : .8;
      const ph = (x * nx + y * ny) * p.flow + (vn(x * .05, y * .05) - .5) * w, tone = 1 - dk(lumT(i)) / 255;
      setc(i, Math.abs(mod(ph, w) - w / 2) < tone * w * .55 + .2 ? INK : PAPER);
    });
  });
  fx('spray', false, { rate: 200, spread: 1 }, 'Spray paint: speckle that builds up wherever you linger.', p => {
    const n = Math.round(p.rate * (P.speed < .5 ? 1.6 : 1)), R0 = rad() * p.spread;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * TAU, g = Math.abs(Math.random() + Math.random() + Math.random() - 1.5) / 1.5, i = sm(P.x + Math.cos(a) * R0 * g, P.y + Math.sin(a) * R0 * g);
      mixc(i, INK, .5 + Math.random() * .5); stamp(i);
    }
  });

  /* ---- ingredients: they change the block right after them ---- */
  const ingredient = (name, params, desc, fn, raw) => { fx(name, false, params, desc, () => {}); const e = E[E.length - 1]; e.mod = fn; e.raw = raw || []; };
  ingredient('mask', { only: 'ink' }, 'Ingredient: the next block only changes ink. --only: paper flips it.', p => ({ mask: String(p.only) }), ['only']);
  ingredient('gate', { when: 'fast', speed: 2 }, 'Ingredient: the next block only runs when you move fast, slow, or hold still. --when: fast, slow or still.', p => {
    const sp = P.speed, w = String(p.when);
    return (w === 'slow' ? sp < p.speed : w === 'still' ? sp < .2 : sp > p.speed) ? null : 'skip';
  }, ['when']);
  ingredient('trail', { delay: 30 }, 'Ingredient: the next block follows where you were a moment ago. --delay is in frames.', p => {
    const d = clamp(Math.round(p.delay), 1, HIST - 2), h = P.past(d), h2 = P.past(d + 1);
    return { move: { x: P.hx[h], y: P.hy[h], dx: P.hx[h] - P.hx[h2], dy: P.hy[h] - P.hy[h2] } };
  });
  ingredient('beat', { bpm: 120 }, 'Ingredient: the next block only updates on the beat, for a stop-motion feel.', (p, k) => {
    const s = st('beat:' + k, () => ({ last: -1 })), b = Math.floor(t * Math.max(1, p.bpm) / 60);
    if (b === s.last) return 'skip';
    s.last = b;
    return null;
  });

  /* group the squares by family; the grid follows this order */
  const FAMILIES = {
    automata: 'automata brain bosco cyclic excite wireworld cascade sandpile lichen wildfire voter sand water',
    creatures: 'ants termites worms hunt flock fireflies spores scribble coral physarum rain erosion',
    growth: 'roots veins sprout frost snowflake mycelium substrate spark ivy hive fur',
    flow: 'smear push pull vortex melt flow diffuse slide tear pulse scroll',
    lens: 'mirror kaleido fold droste inversion hilbert brick quadtree loupe sift',
    mark: 'woodcut spray ridges halo osc dissolve diff rot collapse grain mosh tectonic stamp',
    time: 'rewind exposure feedback',
    ingredient: 'mask gate trail beat',
  };
  const ORDER = [];
  for (const f in FAMILIES) for (const n of FAMILIES[f].split(' ')) { const e = E.find(e => e.name === n); if (e) { e.family = f; ORDER.push(e); } }
  for (const e of E) if (!ORDER.includes(e)) { e.family = 'other'; ORDER.push(e); }
  E.length = 0; E.push(...ORDER);

  const BY_NAME = Object.fromEntries(E.map((e, k) => [e.name, k]));
  const COMMON = { ink: 'auto', paper: 'auto', mix: 1, scale: 1, shape: 'inherit', falloff: 0, spill: 'lens' };

  /* tiny expression language for param values: speed * .2, sin(t) * 3, 1 - x ... */
  const FN = { sin: Math.sin, cos: Math.cos, abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, sqrt: Math.sqrt, pow: Math.pow };
  const VARS = ['speed', 't', 'vx', 'vy', 'x', 'y'];
  const exprCache = {};
  function compile(src) {
    const s = String(src).replace(/\s+/g, '');
    if (!/^[\w.+\-*/(),]+$/.test(s)) return null;
    let i = 0;
    const expr = () => { let a = term(); while (s[i] === '+' || s[i] === '-') { const op = s[i++], b = term(), l = a; a = op === '+' ? e => l(e) + b(e) : e => l(e) - b(e); } return a; };
    const term = () => { let a = unary(); while (s[i] === '*' || s[i] === '/') { const op = s[i++], b = unary(), l = a; a = op === '*' ? e => l(e) * b(e) : e => l(e) / b(e); } return a; };
    const unary = () => { if (s[i] === '-') { i++; const a = unary(); return e => -a(e); } return atom(); };
    const atom = () => {
      if (s[i] === '(') { i++; const a = expr(); if (s[i++] !== ')') throw 0; return a; }
      const m = /^\d*\.?\d+/.exec(s.slice(i));
      if (m) { i += m[0].length; const v = +m[0]; return () => v; }
      const w = /^[a-z_]\w*/i.exec(s.slice(i));
      if (!w) throw 0;
      i += w[0].length;
      const name = w[0];
      if (s[i] === '(') {
        const f = FN[name]; if (!f) throw 0;
        i++;
        const args = [expr()];
        while (s[i] === ',') { i++; args.push(expr()); }
        if (s[i++] !== ')') throw 0;
        return e => f(...args.map(a => a(e)));
      }
      if (!VARS.includes(name)) throw 0;
      return e => e[name];
    };
    try { const f = expr(); return i === s.length ? f : null; } catch (err) { return null; }
  }
  const ENV = { speed: 0, t: 0, vx: 0, vy: 0, x: 0, y: 0 };
  function resolve(e, raw) {
    const out = Object.assign({}, COMMON, E[e].params);
    for (const k in raw) {
      let v = raw[k];
      if (typeof v === 'string' && !(E[e].raw && E[e].raw.includes(k))) {
        if (!(v in exprCache)) exprCache[v] = compile(v);
        const f = exprCache[v];
        if (f) { v = f(ENV); if (!isFinite(v)) v = E[e].params[k] !== undefined ? E[e].params[k] : COMMON[k]; }
      }
      out[k] = v;
    }
    return out;
  }
  function savePre() { const [x0, y0, x1, y1] = lbox(); for (let y = y0; y < y1; y++) pre.set(buf.subarray(idx(x0, y), idx(x1, y)), idx(x0, y)); }
  function blendPre(p) {
    const mix = clamp(+p.mix, 0, 1), fo = +p.falloff;
    lens((i, x, y, d) => {
      const w = mix * (fo > 0 ? clamp((1 - d) / fo, 0, 1) : 1);
      if (w >= 1) return;
      buf[i] = pre[i] + (buf[i] - pre[i]) * w; buf[i + 1] = pre[i + 1] + (buf[i + 1] - pre[i + 1]) * w; buf[i + 2] = pre[i + 2] + (buf[i + 2] - pre[i + 2]) * w;
    });
  }

  /* ---------------- your own effects: @rule and @agent ---------------- */
  const RULE_DEFAULTS = { states: 2, born: '3', survive: '2 3', range: 1, neighbors: 'moore', seed: 'ink', cell: 3, every: 2, shade: 'auto' };
  const AGENT_DEFAULTS = { count: 20, speed: 1, turn: .3, seek: 'ink', avoid: 'trail', trail: 1, shade: .8, eat: 'no', split: 0, life: 300, spawn: 'ink' };
  const RULE_RAW = ['born', 'survive', 'neighbors', 'seed', 'shade'], AGENT_RAW = ['seek', 'avoid', 'eat', 'spawn'];
  function counts(v) {
    const out = new Set();
    String(v).split(/[\s,]+/).forEach(tok => {
      const m = /^(\d+)(?:-(\d+))?$/.exec(tok);
      if (m) { const a = +m[1], b = m[2] != null ? +m[2] : a; for (let k = a; k <= b && k <= 400; k++) out.add(k); }
    });
    return out;
  }
  const ruleRun = name => p => {
    const G = cellSize(p.cell), n = clamp(Math.round(p.states), 2, 24), r = clamp(Math.round(p.range), 1, 8);
    const g = st('u:' + name + ':' + G, () => makeGrid(G, { a: Uint8Array, b: Uint8Array }));
    if (g.bs !== String(p.born)) { g.bs = String(p.born); g.born = counts(p.born); }
    if (g.ss !== String(p.survive)) { g.ss = String(p.survive); g.surv = counts(p.survive); }
    touch(g, r + 3);
    const seed = String(p.seed);
    lensCells(g, (k, x, y) => {
      if (g.a[k]) return;
      if (seed === 'ink' ? inkAt(g, x, y) && Math.random() < .3 : seed === 'cursor' ? Math.random() < .08 * (1 + P.speed * .3) : P.speed > .3 && Math.random() < .4) g.a[k] = 1;
    });
    if (fr % Math.max(1, Math.round(p.every)) === 0 && g.box) {
      const a = g.a, gw = g.gw, cross = /cross|von/.test(String(p.neighbors));
      const rule = (k, c) => { const v = a[k]; g.b[k] = v === 0 ? (g.born.has(c) ? 1 : 0) : v === 1 ? (g.surv.has(c) ? 1 : n > 2 ? 2 : 0) : v + 1 >= n ? 0 : v + 1; };
      if (r === 1) {
        eachCell(g, k => {
          const c = cross ? (a[k - 1] === 1) + (a[k + 1] === 1) + (a[k - gw] === 1) + (a[k + gw] === 1)
            : (a[k - gw - 1] === 1) + (a[k - gw] === 1) + (a[k - gw + 1] === 1) + (a[k - 1] === 1) + (a[k + 1] === 1) + (a[k + gw - 1] === 1) + (a[k + gw] === 1) + (a[k + gw + 1] === 1);
          rule(k, c);
        }, true);
      } else {
        const [x0, y0, x1, y1] = g.box, bw = x1 - x0, bh = y1 - y0, sat = new Int32Array((bw + 1) * (bh + 1));
        for (let y = 0; y < bh; y++) { let row = 0; for (let x = 0; x < bw; x++) { row += a[(y0 + y) * gw + x0 + x] === 1 ? 1 : 0; sat[(y + 1) * (bw + 1) + x + 1] = sat[y * (bw + 1) + x + 1] + row; } }
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          const ax = Math.max(0, x - r), ay = Math.max(0, y - r), bx = Math.min(bw, x + r + 1), by = Math.min(bh, y + r + 1), k = (y0 + y) * gw + x0 + x;
          rule(k, sat[by * (bw + 1) + bx] - sat[ay * (bw + 1) + bx] - sat[by * (bw + 1) + ax] + sat[ay * (bw + 1) + ax] - (a[k] === 1 ? 1 : 0));
        }
      }
      copyBack(g, g.b, g.a);
    }
    const shades = String(p.shade) === 'auto' ? null : String(p.shade).split(/[\s,]+/).map(Number).filter(v => !isNaN(v));
    eachCell(g, (k, x, y) => {
      const v = g.a[k];
      if (!v) return;
      const w = shades && shades.length ? shades[Math.min(v - 1, shades.length - 1)] : v === 1 ? 1 : (1 - (v - 1) / n) * .55;
      paintCell(g, x, y, INK, w);
    });
  };
  const agentRun = name => p => {
    const s = st('u:' + name, () => ({ ag: [], occ: new Uint8Array(N) }));
    const max = clamp(Math.round(p.count), 1, 600), seek = String(p.seek), avoid = String(p.avoid), spawn = String(p.spawn), eat = /^(yes|true|1)$/.test(String(p.eat));
    for (let k = 0; k < 3 && s.ag.length < max; k++) {
      const at = spawn === 'ink' ? pick(inkPx, 150) : spawn === 'paper' ? pick((x, y) => !inkPx(x, y), 150) : null;
      s.ag.push({ x: at ? at[0] : P.x, y: at ? at[1] : P.y, a: Math.random() * TAU, life: p.life * (.7 + Math.random() * .6) });
    }
    const val = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return -1e9;
      const ink = inkPx(x, y);
      let v = Math.random() * .5;
      if (seek === 'ink' && ink) v += 2;
      else if (seek === 'paper' && !ink) v += 2;
      else if (seek === 'cursor') v -= Math.hypot(P.x - x, P.y - y) / rad();
      if (avoid === 'trail' && s.occ[(y | 0) * W + (x | 0)]) v -= 3;
      else if (avoid === 'ink' && ink) v -= 3;
      else if (avoid === 'paper' && !ink) v -= 3;
      return v;
    };
    const born = [], spd = Math.max(.1, p.speed), steps = Math.ceil(spd), tw = Math.max(0, p.trail);
    for (const q of s.ag) for (let k = 0; k < steps && q.life > 0; k++) {
      let best = q.a, bv = -1e9;
      for (const da of [-.5, 0, .5]) { const a = q.a + da, v = val(q.x + Math.cos(a) * 4, q.y + Math.sin(a) * 4); if (v > bv) { bv = v; best = a; } }
      q.a = best + (Math.random() - .5) * 2 * p.turn;
      q.x += Math.cos(q.a) * spd / steps; q.y += Math.sin(q.a) * spd / steps; q.life--;
      if (q.x < 0 || q.y < 0 || q.x >= W || q.y >= H) { q.life = 0; break; }
      if (tw > 0 || eat) {
        const rr = Math.max(.5, tw / 2);
        for (let dy = -Math.ceil(rr); dy <= Math.ceil(rr); dy++) for (let dx = -Math.ceil(rr); dx <= Math.ceil(rr); dx++) {
          if (dx * dx + dy * dy > rr * rr + .25) continue;
          const i = sm(q.x + dx, q.y + dy);
          if (eat) setc(i, PAPER); else mixc(i, INK, p.shade);
          stamp(i); s.occ[i >> 2] = 1;
        }
      }
      if (Math.random() < p.split && s.ag.length + born.length < max * 3) born.push({ x: q.x, y: q.y, a: q.a + (Math.random() < .5 ? -.8 : .8), life: q.life * .7 });
    }
    s.ag = s.ag.filter(q => q.life > 0).concat(born);
    for (const q of s.ag) setc(sm(q.x, q.y), INK);
  };
  const GROWTH_DEFAULTS = { angle: 35, split: .04, length: 120, toward: 'up', wiggle: .15, width: 1, shade: .9, seed: 'ink', tips: 60 };
  const FIELD_DEFAULTS = { toward: 'cursor', spin: .5, strength: 1, noise: .3, scale: .02 };
  const growthRun = name => p => {
    const s = st('u:' + name, () => ({ tips: [] }));
    const max = clamp(Math.round(p.tips), 1, 600), tw = String(p.toward), ang = p.angle * Math.PI / 180, w = Math.max(.5, p.width / 2);
    for (let k = 0; k < 2 && s.tips.length < max; k++) {
      const at = String(p.seed) === 'ink' ? pick((x, y) => inkPx(x, y), 150) : null, x = at ? at[0] : P.x, y = at ? at[1] : P.y;
      s.tips.push({ x, y, ox: x, oy: y, a: tw === 'down' ? Math.PI / 2 : tw === 'up' ? -Math.PI / 2 : Math.random() * TAU, life: p.length * (.6 + Math.random() * .6) });
    }
    const born = [];
    for (const q of s.tips) for (let k = 0; k < 2 && q.life > 0; k++) {
      let target = null;
      if (tw === 'up') target = -Math.PI / 2; else if (tw === 'down') target = Math.PI / 2;
      else if (tw === 'out') target = Math.atan2(q.y - q.oy, q.x - q.ox);
      else if (tw === 'cursor') target = Math.atan2(P.y - q.y, P.x - q.x);
      else if (tw === 'ink') { let bv = -1; for (const da of [-.5, 0, .5]) { const a = q.a + da, v = (inkPx(q.x + Math.cos(a) * 5, q.y + Math.sin(a) * 5) ? 1 : 0) + Math.random() * .5; if (v > bv) { bv = v; target = a; } } }
      if (target != null) q.a += Math.atan2(Math.sin(target - q.a), Math.cos(target - q.a)) * .08;
      q.a += (Math.random() - .5) * 2 * p.wiggle;
      q.x += Math.cos(q.a); q.y += Math.sin(q.a); q.life--;
      if (q.x < 0 || q.y < 0 || q.x >= W || q.y >= H) { q.life = 0; break; }
      for (let dy = -Math.ceil(w); dy <= Math.ceil(w); dy++) for (let dx = -Math.ceil(w); dx <= Math.ceil(w); dx++) {
        if (dx * dx + dy * dy > w * w + .25) continue;
        const i = sm(q.x + dx, q.y + dy); mixc(i, INK, p.shade); stamp(i);
      }
      if (Math.random() < p.split && s.tips.length + born.length < max * 4) {
        const sgn = Math.random() < .5 ? 1 : -1;
        born.push({ x: q.x, y: q.y, ox: q.ox, oy: q.oy, a: q.a + sgn * ang, life: q.life * .75 });
      }
    }
    s.tips = s.tips.filter(q => q.life > 0).concat(born);
  };
  const fieldRun = () => p => {
    snap();
    const s = p.scale, z = t * .05, tw = String(p.toward);
    lens((i, x, y, d, ux, uy) => {
      const r = Math.hypot(ux, uy) || 1;
      let vx = 0, vy = 0;
      if (tw === 'cursor') { vx -= ux / r; vy -= uy / r; }
      else if (tw === 'out') { vx += ux / r; vy += uy / r; }
      else if (tw === 'down') vy += 1; else if (tw === 'up') vy -= 1; else if (tw === 'left') vx -= 1; else if (tw === 'right') vx += 1;
      else if (tw === 'ink') {
        const gx = dk(lumP(sm(x + 2, y))) - dk(lumP(sm(x - 2, y))), gy = dk(lumP(sm(x, y + 2))) - dk(lumP(sm(x, y - 2))), m = Math.hypot(gx, gy);
        if (m > 4) { vx -= gx / m; vy -= gy / m; }
      }
      vx += -uy / r * p.spin; vy += ux / r * p.spin;
      vx += (vn(x * s + z, y * s + 3.1) - .5) * 2 * p.noise; vy += (vn(x * s - 7.7, y * s - z) - .5) * 2 * p.noise;
      const f = p.strength * (1 - d);
      put(i, sm(x - vx * f, y - vy * f));
    });
  };
  const LENS_DEFAULTS = { folds: 0, mirror: 'none', zoom: 1, twist: 0, spin: 0, repeat: 1, wave: 0, pixel: 1 };
  const MARK_DEFAULTS = { stroke: 'line', size: 6, angle: 30, follow: 'no', weight: 1, jitter: 0 };
  const lensRun = () => p => {
    const R0 = rad(), px = Math.max(1, p.pixel), rp = Math.max(1, Math.round(p.repeat)), mi = String(p.mirror), f = Math.round(p.folds);
    warp((x, y, d, ux, uy) => {
      let u = ux, v = uy;
      if (px > 1) { u = (Math.floor(u / px) + .5) * px; v = (Math.floor(v / px) + .5) * px; }
      if (rp > 1) { const cs = 2 * R0 / rp; u = (mod(u + R0, cs) - cs / 2) * rp; v = (mod(v + R0, cs) - cs / 2) * rp; }
      if (mi === 'x' || mi === 'both') u = -Math.abs(u);
      if (mi === 'y' || mi === 'both') v = -Math.abs(v);
      let r = Math.hypot(u, v), a = Math.atan2(v, u);
      if (f >= 2) { const seg = TAU / f; a = mod(a, seg); if (a > seg / 2) a = seg - a; }
      a += p.twist * (1 - Math.min(1, r / R0)) + t * p.spin;
      r *= p.zoom;
      u = Math.cos(a) * r; v = Math.sin(a) * r;
      if (p.wave) { const u0 = u; u += Math.sin(v * .15 + t * 3) * p.wave; v += Math.cos(u0 * .15 + t * 3) * p.wave; }
      return sm(P.x + u, P.y + v);
    });
  };
  const markRun = () => p => {
    snap();
    const sz = Math.max(2, p.size), A = p.angle * Math.PI / 180, kind = String(p.stroke), follow = /^(yes|shape|true)$/.test(String(p.follow));
    lens((i, x, y) => {
      const tone = Math.min(1, (1 - dk(lumT(i)) / 255) * p.weight);
      let a = A;
      if (follow) { const gx = lumT(sm(x + 3, y)) - lumT(sm(x - 3, y)), gy = lumT(sm(x, y + 3)) - lumT(sm(x, y - 3)); if (gx * gx + gy * gy > 64) a = Math.atan2(gy, gx) + Math.PI / 2; }
      const jit = p.jitter ? (vn(x * .08, y * .08) - .5) * p.jitter * sz : 0;
      const band = g => Math.abs(mod(x * Math.cos(g) + y * Math.sin(g) + jit, sz) - sz / 2);
      let on;
      if (kind === 'dot') { const cx = (Math.floor(x / sz) + .5) * sz, cy = (Math.floor(y / sz) + .5) * sz; on = Math.hypot(x - cx, y - cy) < Math.sqrt(tone) * sz * .6; }
      else if (kind === 'stipple') on = Math.random() < tone * tone * 1.2;
      else if (kind === 'grain') on = vn(x * .35 + jit, y * .35) < tone;
      else if (kind === 'cross') on = band(a) < tone * sz * .35 || band(a + Math.PI / 2) < tone * sz * .35;
      else if (kind === 'hatch') on = band(a) < tone * sz * .5 || (tone > .5 && band(a + Math.PI / 2) < (tone - .5) * sz * .7);
      else on = band(a) < tone * sz * .5 + .15;
      setc(i, on ? INK : PAPER);
    });
  };
  const KINDS = {
    lens: [LENS_DEFAULTS, ['mirror'], 'Your lens.', lensRun, false],
    mark: [MARK_DEFAULTS, ['stroke', 'follow'], 'Your mark.', markRun, false],
    rule: [RULE_DEFAULTS, RULE_RAW, 'Your automaton.', ruleRun, false],
    agent: [AGENT_DEFAULTS, AGENT_RAW, 'Your agents.', agentRun, false],
    growth: [GROWTH_DEFAULTS, ['toward', 'seed'], 'Your growth.', growthRun, false],
    field: [FIELD_DEFAULTS, ['toward'], 'Your field.', fieldRun, true],
  };
  function define(kind, name, spec) {
    if (!KINDS[kind]) return '@' + kind + ' is not a kind. use @rule, @agent, @growth, @field, @lens or @mark';
    if (!/^[a-z][\w-]*$/i.test(name)) return 'names use letters, numbers and dashes';
    const prev = BY_NAME[name];
    if (prev !== undefined && !E[prev].custom) return '.' + name + ' is already a built-in effect';
    const [defs0, raw, desc, make, persist] = KINDS[kind];
    const e = {
      name, persist, family: 'yours', custom: kind,
      params: Object.assign({}, defs0, spec), raw, desc, run: make(name),
    };
    if (prev !== undefined) E[prev] = e; else { BY_NAME[name] = E.length; E.push(e); }
    for (const k in state) if (k === 'u:' + name || k.startsWith('u:' + name + ':')) delete state[k];
    return null;
  }

  function frame(stack, px, py, o) {
    t = performance.now() / 1000; fr++;
    setTheme(!!o.dark);
    P.move(px, py);
    composite(o.keep);
    recordHistory();
    if (o.active && stack.length) {
      const hh = o.R, hw = o.R * (o.aspect || 1), circ = o.shape === 'circle';
      const x0 = Math.max(0, Math.floor(P.x - hw)), x1 = Math.min(W, Math.ceil(P.x + hw) + 1), y0 = Math.max(0, Math.floor(P.y - hh)), y1 = Math.min(H, Math.ceil(P.y + hh) + 1);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const nx = (x - P.x) / hw, ny = (y - P.y) / hh;
        if (circ ? nx * nx + ny * ny <= 1 : true) reach[y * W + x] = 255;
      }
      if (x1 > x0 && y1 > y0) reachBox = reachBox ? [Math.min(reachBox[0], x0), Math.min(reachBox[1], y0), Math.max(reachBox[2], x1), Math.max(reachBox[3], y1)] : [x0, y0, x1, y1];
    }
    if (reachBox && fr % 3 === 0) {
      let any = false;
      for (let y = reachBox[1]; y < reachBox[3]; y++) for (let k = y * W + reachBox[0], e = y * W + reachBox[2]; k < e; k++) if (reach[k]) { reach[k]--; any = true; }
      if (!any) reachBox = null;
    }
    P.twinX = P.twinY = null;
    if (!o.active || !stack.length) return;
    Object.assign(ENV, { speed: P.speed, t, vx: P.vx, vy: P.vy, x: P.x / W, y: P.y / H });
    const twin = stack.find(s => E[s.eff] && E[s.eff].twin);
    const chain = stack.filter(s => E[s.eff] && !E[s.eff].twin);
    runChain(chain, o);
    if (!twin || !chain.length) return;
    const tp = resolve(twin.eff, twin.p || {}), mode = String(tp.mode);
    const keepP = { x: P.x, y: P.y, dx: P.dx, dy: P.dy, vx: P.vx, vy: P.vy };
    if (mode === 'echo') {
      const d = clamp(Math.round(tp.delay), 1, HIST - 2), h = P.past(d), h2 = P.past(d + 1);
      Object.assign(P, { x: P.hx[h], y: P.hy[h], dx: P.hx[h] - P.hx[h2], dy: P.hy[h] - P.hy[h2] });
    } else {
      const fx2 = mode !== 'vertical', fy2 = mode !== 'horizontal';
      Object.assign(P, { x: fx2 ? W - P.x : P.x, y: fy2 ? H - P.y : P.y, dx: fx2 ? -P.dx : P.dx, dy: fy2 ? -P.dy : P.dy, vx: fx2 ? -P.vx : P.vx, vy: fy2 ? -P.vy : P.vy });
    }
    const tx = P.x, ty = P.y;
    runChain(chain, o);
    Object.assign(P, keepP);
    P.twinX = tx; P.twinY = ty;
  }
  function runChain(stack, o) {
    const hh = o.R, hw = o.R * (o.aspect || 1);
    let last = -1;
    stack.forEach((s, k) => { if (E[s.eff].persist) last = k; });
    if (o.bakeAll) last = stack.length - 1;
    let mods = [];
    stack.forEach((s, k) => {
      const e = E[s.eff];
      if (!e) return;
      const p = resolve(s.eff, s.p || {}), sc = +p.scale > 0 ? +p.scale : 1;
      P.hw = hw * sc; P.hh = hh * sc;
      P.circle = (p.shape === 'inherit' ? o.shape : p.shape) === 'circle';
      if (e.mod) { mods.push({ e, p, k }); if (k === last) { const b = lbox(); bakeRect(b[0], b[1], b[2], b[3]); } return; }
      let skip = false, moved = null, mask = null;
      for (const m of mods) { const r = m.e.mod(m.p, m.k); if (r === 'skip') skip = true; else if (r && r.move) moved = r.move; else if (r && r.mask) mask = r.mask; }
      mods = [];
      if (!skip) {
        const was = moved && { x: P.x, y: P.y, dx: P.dx, dy: P.dy };
        if (moved) Object.assign(P, moved);
        if (mask) mpre.set(buf);
        const blend = +p.mix < 1 || +p.falloff > 0;
        if (blend) savePre();
        // --ink / --paper: effects draw in these colours, and the lens is recoloured
        // from paper to ink by tone, so even effects that only move pixels take the colour
        const inkC = p.ink && p.ink !== 'auto' ? rgb(p.ink) : null, paperC = p.paper && p.paper !== 'auto' ? rgb(p.paper) : null;
        if (inkC) for (let q = 0; q < 3; q++) INK[q] = inkC[q];
        if (paperC) for (let q = 0; q < 3; q++) PAPER[q] = paperC[q];
        const spill = String(p.spill), guard = spill === 'lens' || spill === 'trail';
        spillMode = guard ? spill : 'free';
        if (guard) spre32.set(buf32);
        e.run(p);
        if (guard) {
          for (let k = 0; k < N; k++) {
            if (buf32[k] === spre32[k]) continue;
            if (spill === 'lens' ? !inL(k % W, (k / W) | 0) : !reach[k]) buf32[k] = spre32[k];
          }
        }
        spillMode = 'free';
        if (inkC || paperC) {
          setTheme(DARK);
          const I = inkC || INK.slice(), Pp = paperC || PAPER.slice();
          lens(i => { const tn = 1 - dk(lum(i)) / 255; for (let c = 0; c < 3; c++) buf[i + c] = Pp[c] + (I[c] - Pp[c]) * tn; });
        }
        if (blend) blendPre(p);
        if (mask) {
          const wantInk = mask !== 'paper';
          for (let i = 0; i < buf.length; i += 4) {
            if (buf[i] === mpre[i] && buf[i + 1] === mpre[i + 1] && buf[i + 2] === mpre[i + 2]) continue;
            if ((dk(lumP(i)) < 160) !== wantInk) { buf[i] = mpre[i]; buf[i + 1] = mpre[i + 1]; buf[i + 2] = mpre[i + 2]; }
          }
        }
        if (was) Object.assign(P, was);
      }
      if (k === last) { const b = lbox(); bakeRect(b[0], b[1], b[2], b[3]); }
    });
  }
  function reset() {
    img.fill(0); mark.fill(0); markBox = null; P.held.fill(0); reach.fill(0); reachBox = null;
    for (const k in state) delete state[k];
  }
  function clearMarks(x0, y0, x1, y1) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
    for (let y = y0; y < y1; y++) if (x1 > x0) mark.fill(0, y * W + x0, y * W + x1);
  }
  return { W, H, page, buf, P, EFFECTS: E, BY_NAME, COMMON, frame, reset, define, clearMarks };
}

/* ================================================================
   EXPORT ADAPTER. Shipped with the engine: runs effects on any
   <img>, <video> or <canvas> marked data-petri.
   ================================================================ */
function petriAdapter(CONFIG, createPipeline) {
  const attach = el => {
    const cvs = document.createElement('canvas');
    cvs.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483646;image-rendering:pixelated';
    document.body.appendChild(cvs);
    const ctx = cvs.getContext('2d'), off = document.createElement('canvas'), octx = off.getContext('2d', { willReadFrequently: true });
    const moving = el.tagName === 'VIDEO' || el.tagName === 'CANVAS';
    let eng = null, data = null, W = 0, H = 0, fresh = true, mx = -1e5, my = -1e5, stack = [];
    addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; });
    const tick = () => {
      const r = el.getBoundingClientRect();
      Object.assign(cvs.style, { left: r.left + scrollX + 'px', top: r.top + scrollY + 'px', width: r.width + 'px', height: r.height + 'px' });
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (w !== W || h !== H) {
        W = w; H = h; cvs.width = off.width = W; cvs.height = off.height = H;
        eng = createPipeline(W, H); data = new ImageData(eng.buf, W, H); fresh = true;
        (CONFIG.defs || []).forEach(d => eng.define(d.kind, d.name, d.spec));
        stack = CONFIG.stack.map(s => { const p = Object.assign({}, s); delete p.effect; return { eff: eng.BY_NAME[s.effect], p }; }).filter(s => s.eff !== undefined);
      }
      if (moving || fresh) {
        try { octx.drawImage(el, 0, 0, W, H); eng.page.set(octx.getImageData(0, 0, W, H).data); fresh = false; }
        catch (err) { console.warn('petri: cannot read this element\'s pixels (cross-origin?)', el); return; }
      }
      const x = mx - r.left, y = my - r.top;
      eng.frame(stack, x, y, { R: CONFIG.radius, aspect: CONFIG.aspect, shape: CONFIG.shape, active: x >= 0 && y >= 0 && x < r.width && y < r.height });
      ctx.putImageData(data, 0, 0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const go = () => document.querySelectorAll('[data-petri]').forEach(el => {
    if (el.tagName === 'IMG' && !el.complete) el.addEventListener('load', () => attach(el), { once: true });
    else attach(el);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
}

/* ================================================================
   RECIPE FORMAT. A recipe is CSS-shaped text:
     .cursor { --radius; --shape }      the lens
     .square { --name }                 a name, when saved as a square
     @rule | @agent | @growth | @field  invented effects
     .effect { --param: value; }        the stack, top to bottom
   ================================================================ */
function parseRecipe(text) {
  const clean = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const props = body => {
    const out = {};
    body.replace(/--([\w-]+)\s*:\s*([^;]+);?/g, (_, k, v) => {
      v = v.trim();
      out[k] = /^-?\d*\.?\d+$/.test(v) ? parseFloat(v) : v.replace(/^["']|["']$/g, '');
    });
    return out;
  };
  const recipe = { cursor: {}, square: {}, defs: [], blocks: [] };
  const re = /@(rule|agent|growth|field|lens|mark)\s+([\w-]+)\s*\{([^}]*)\}|\.([\w-]+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    if (m[1]) recipe.defs.push({ kind: m[1], name: m[2], spec: props(m[3]) });
    else if (m[4] === 'cursor') recipe.cursor = props(m[5]);
    else if (m[4] === 'square') recipe.square = props(m[5]);
    else recipe.blocks.push({ name: m[4], props: props(m[5]) });
  }
  return recipe;
}

/* ================================================================
   LIBRARY. pipeline(canvas, recipe) -> { frame, follow, setRecipe, ... }
   Shipped as an ES module by the export panel.
   ================================================================ */
function pipelineFactory(createPipeline, parseRecipe) {
  return function pipeline(canvas, recipe, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    const off = document.createElement('canvas'), octx = off.getContext('2d', { willReadFrequently: true });
    let eng = null, img = null, stack = [], current = parseRecipe('');
    const cursor = { radius: 40, shape: 'circle' };
    const api = { keep: !!opts.keep, freeze: !!opts.freeze, dark: !!opts.dark };
    const apply = () => {
      current.defs.forEach(d => eng.define(d.kind, d.name, d.spec));
      stack = current.blocks.filter(b => b.name in eng.BY_NAME).map(b => ({ eff: eng.BY_NAME[b.name], p: b.props }));
      if (+current.cursor.radius > 0) cursor.radius = +current.cursor.radius;
      if (current.cursor.shape) cursor.shape = String(current.cursor.shape);
    };
    const build = () => {
      eng = createPipeline(canvas.width, canvas.height);
      img = new ImageData(eng.buf, canvas.width, canvas.height);
      off.width = canvas.width; off.height = canvas.height;
      apply();
    };
    api.setRecipe = r => { current = typeof r === 'string' ? parseRecipe(r) : (r || current); if (eng) apply(); return api; };
    api.setSource = src => {
      if (!src) return api;
      if (typeof ImageData !== 'undefined' && src instanceof ImageData) eng.page.set(src.data);
      else { octx.drawImage(src, 0, 0, off.width, off.height); eng.page.set(octx.getImageData(0, 0, off.width, off.height).data); }
      return api;
    };
    api.frame = (src, input) => {
      input = input || {};
      if (!eng || canvas.width !== off.width || canvas.height !== off.height) build();
      if (src) api.setSource(src);
      const has = input.x != null && input.y != null;
      eng.frame(stack, has ? input.x : -1e5, has ? input.y : -1e5, {
        R: input.radius || cursor.radius, aspect: 1, shape: cursor.shape,
        keep: api.keep || api.freeze, bakeAll: api.freeze, dark: api.dark, active: has && input.active !== false,
      });
      ctx.putImageData(img, 0, 0);
      return api;
    };
    api.follow = el => {
      let x = null, y = null, alive = true, first = true;
      const move = e => {
        const r = el.getBoundingClientRect();
        x = (e.clientX - r.left) * canvas.width / r.width; y = (e.clientY - r.top) * canvas.height / r.height;
        if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) x = y = null;
      };
      addEventListener('pointermove', move);
      const live = el !== canvas && (el.tagName === 'VIDEO' || el.tagName === 'CANVAS');
      const loop = () => {
        if (!alive) return;
        try { api.frame(live || first ? el : null, { x, y }); first = false; }
        catch (err) { console.warn('petri: cannot read this element (cross-origin?)', err); return; }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      return () => { alive = false; removeEventListener('pointermove', move); };
    };
    api.reset = () => { if (eng) eng.reset(); return api; };
    api.effects = () => eng.EFFECTS.map(e => ({ name: e.name, family: e.family, about: e.desc, params: Object.assign({}, e.params) }));
    build();
    api.setRecipe(recipe || '');
    return api;
  };
}

/* ================================================================
   APP: draws the page into the engine, handles squares, panel, info.
   ================================================================ */
(() => {
'use strict';

const NAMES = createPipeline(1, 1).EFFECTS.map(e => e.name);
const LINE = '#e8e6ee', INK_HEX = '#14102a', INK = [20, 16, 42];

const cvs = document.getElementById('c'), ctx = cvs.getContext('2d');
const ringEl = document.getElementById('ring'), ring2El = document.getElementById('ring2'), holdEl = document.getElementById('hold');
const infoEl = document.getElementById('info');
const panel = document.getElementById('panel'), cssEl = document.getElementById('css'), statusEl = document.getElementById('status');
const advBtn = document.getElementById('adv'), lockBtn = document.getElementById('lock'), exportBtn = document.getElementById('export');
const copyBtn = document.getElementById('copy'), titleEl = document.getElementById('ptitle');

let defs = [], texts = [], liveDefs = {};
try { defs = JSON.parse(localStorage.getItem('petri-defs') || localStorage.getItem('cursor-pipeline-defs') || '[]'); } catch (e) { defs = []; }
try { localStorage.removeItem('cursor-pipeline-text'); localStorage.removeItem('petri-text'); } catch (e) {}
const saveDefs = () => { try { localStorage.setItem('petri-defs', JSON.stringify(defs)); } catch (e) {} };
const saveTexts = () => {};  // words live only for this visit
let writing = false, activeText = -1, textSize = 40;
let customs = [];
try { customs = JSON.parse(localStorage.getItem('petri-customs') || localStorage.getItem('cursor-pipeline-customs') || '[]'); } catch (e) { customs = []; }
const saveCustoms = () => { try { localStorage.setItem('petri-customs', JSON.stringify(customs)); } catch (e) {} };

let panX = 0, dockW = 0;
function setPan(v) { panX = Math.max(0, Math.min((panelOpen || infoOpen) ? dockW : 0, v)); cvs.style.transform = panX ? 'translateX(' + (-panX) + 'px)' : ''; }
let eng, imgData, S = 1, W = 0, H = 0, gw, gh, cols, rows, cw, ch, page0, pctx;
let tiles = [], hoverTile = -1, inside = false, panelOpen = false, infoOpen = false;
let showLines = false, showLabels = false, dark = !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
let freeze = false, solo = false, keep = false, advanced = false, exporting = false, lensShape = 'circle', baseImg = null;
let mx = innerWidth / 2, my = innerHeight / 2, R = 40;
let stuck = [];

const defaults = e => Object.assign({}, eng.EFFECTS[e].params);
function tileInsts(tile) {
  if (tile.kind === 'effect') return [{ eff: tile.eff, p: defaults(tile.eff), src: tile.key }];
  if (tile.kind === 'custom') return tile.blocks.filter(b => b.e in eng.BY_NAME)
    .map(b => ({ eff: eng.BY_NAME[b.e], p: Object.assign(defaults(eng.BY_NAME[b.e]), b.p), src: tile.key }));
  return [];
}
const isFx = tile => tile.kind === 'effect' || tile.kind === 'custom';
const UI = [];
const uiOn = kind => kind === 'image' ? !!baseImg : kind === 'keep' ? keep : kind === 'solo' ? solo : kind === 'css' ? panelOpen : kind === 'info' ? infoOpen : false;
const uiName = kind => kind === 'image' && baseImg ? 'clear image' : kind;
const aspect = () => lensShape === 'circle' ? 1 : cw / ch;
const UI_CAT = { image: 'base', keep: 'marks', solo: 'hover' };
function catOf(tile) {
  if (tile.kind === 'custom') return 'your stack';
  if (tile.kind === 'add') return 'new';
  if (UI_CAT[tile.kind]) return UI_CAT[tile.kind];
  return tile.kind === 'effect' ? eng.EFFECTS[tile.eff].family : '';
}

function layout(n) {
  let best = null;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c), score = Math.abs(Math.log((gw / c) / (gh / r))) + (c * r - n) * .03;
    if (!best || score < best.score) best = { c, r, score };
  }
  return best;
}

function defineAll() {
  for (const d of defs) eng.define(d.kind, d.name, d.spec);
  for (const n in liveDefs) eng.define(liveDefs[n].kind, n, liveDefs[n].spec);
}
const keyOf = e => e < NAMES.length ? 'e' + e : 'd:' + eng.EFFECTS[e].name;

/* the engine lives as long as the window size does, so panels and new squares never wipe it */
function setup() {
  S = Math.max(1, Math.ceil(innerWidth / 1700));
  const w = Math.ceil(innerWidth / S), h = Math.ceil(innerHeight / S);
  if (w !== W || h !== H || !eng) {
    W = w; H = h;
    cvs.width = W; cvs.height = H;
    cvs.style.width = W * S + 'px'; cvs.style.height = H * S + 'px';
    eng = createPipeline(W, H);
    defineAll();
    imgData = new ImageData(eng.buf, W, H);
    const oc = document.createElement('canvas');
    oc.width = W; oc.height = H;
    pctx = oc.getContext('2d', { willReadFrequently: true });
  }
  relayout();
}
function relayout() {
  const wide = innerWidth >= 720;
  const pw = Math.min(460, Math.round(innerWidth * (wide ? .4 : 1)));
  dockW = wide ? pw : 0;
  document.documentElement.style.setProperty('--pw', pw + 'px');
  gw = innerWidth;   // panels open over the grid; the grid never rescales
  if (!panelOpen && !infoOpen) setPan(0);
  gh = innerHeight;

  const items = NAMES.map((name, k) => ({ kind: 'effect', key: 'e' + k, eff: k, name }))
    .concat(defs.filter(d => d.name in eng.BY_NAME).map(d => ({ kind: 'effect', key: 'd:' + d.name, eff: eng.BY_NAME[d.name], name: d.name })))
    .concat(customs.map(c => ({ kind: 'custom', key: 'c' + c.id, blocks: c.blocks, name: '★ ' + c.name })));
  const lay = layout(items.length + UI.length);
  cols = lay.c; rows = lay.r; cw = gw / cols; ch = gh / rows;
  while (items.length < cols * rows - UI.length) items.push({ kind: 'blank', key: 'b' + items.length, name: '' });
  UI.forEach(kind => items.push({ kind, key: kind, name: kind }));

  const prevR = R;
  R = Math.max(10, Math.round(Math.min(cw, ch) / S * .5));
  if (tiles.length && prevR) R = prevR;
  tiles = items.map((it, k) => {
    const c = k % cols, r = k / cols | 0;
    const rect = [Math.round(c * cw / S), Math.round(r * ch / S), Math.min(W, Math.round((c + 1) * cw / S)), Math.min(H, Math.round((r + 1) * ch / S))];
    return Object.assign(it, { rect, ang: { x: 1, y: 0 }, chip: null });
  });
  const valid = new Set(tiles.map(t => t.key));
  stuck = stuck.filter(s => valid.has(s.src));
  hoverTile = -1;
  sizeInfo();
  refresh();
}

/* ---------- drawing the page ---------- */

function renderPage() {
  const g = pctx, fs = Math.max(7, Math.round(11 / S)), pad = Math.round(8 / S), T = theme();
  g.fillStyle = T.paper; g.fillRect(0, 0, W, H);
  if (baseImg) {
    const bw = baseImg.videoWidth || baseImg.width, bh = baseImg.videoHeight || baseImg.height, k = Math.max(W / bw, H / bh), iw = bw * k, ih = bh * k;
    g.drawImage(baseImg, (W - iw) / 2, (H - ih) / 2, iw, ih);
  }
  g.textBaseline = 'alphabetic';
  const many = stuck.length > 1;
  for (let k = 0; k < tiles.length; k++) {
    const tile = tiles[k], [x0, y0, x1, y1] = tile.rect, w = x1 - x0, h = y1 - y0;
    const order = isFx(tile) ? stuck.findIndex(s => s.src === tile.key) : -1;
    const live = isFx(tile) && (order >= 0 || (k === hoverTile && !solo));
    const on = (UI.includes(tile.kind) && uiOn(tile.kind)) || (tile.kind === 'add' && creating);
    tile.live = live; tile.stuck = order >= 0; tile.chip = null;
    if (on) { g.fillStyle = T.ink; g.fillRect(x0, y0, w, h); }
    if (showLines) {
      g.fillStyle = baseImg ? 'rgba(255,255,255,.45)' : T.line;
      g.fillRect(x1 - 1, y0, 1, h); g.fillRect(x0, y1 - 1, w, 1);
    }
    if (tile.kind === 'add') {
      const arm = Math.round(Math.min(w, h) * .1), th = Math.max(1, Math.round(1.5 / S)), cx = Math.round(x0 + w / 2), cy = Math.round(y0 + h / 2 - (showLabels ? fs : 0));
      g.fillStyle = on ? T.paper : T.ink;
      g.fillRect(cx - arm, cy - (th >> 1), arm * 2, th); g.fillRect(cx - (th >> 1), cy - arm, th, arm * 2);
    }
    if (!showLabels) continue;
    const name = UI.includes(tile.kind) ? uiName(tile.kind) : tile.name;
    if (!name) continue;
    const text = name + (many && order >= 0 ? ' ·' + (order + 1) : '');
    const cat = catOf(tile), lh = Math.round(fs * 1.45);
    const font = (UI.includes(tile.kind) ? '700 ' : '') + fs + 'px "JetBrains Mono", ui-monospace, monospace';
    g.font = font;
    let tw = g.measureText(text).width;
    g.font = fs + 'px "JetBrains Mono", ui-monospace, monospace';
    tw = Math.min(Math.max(tw, g.measureText(cat).width), w - pad * 2);
    const tx = x0 + pad, ty = y1 - pad - 1;
    const chipped = live || (baseImg && !on);
    if (chipped) {
      const cp = Math.max(2, Math.round(4 / S));
      tile.chip = [Math.max(x0, tx - cp), Math.max(y0, ty - fs - lh - cp + 2), Math.min(x1, Math.ceil(tx + tw + cp)), Math.min(y1, ty + cp + 1)];
      g.fillStyle = order >= 0 ? T.ink : T.paper;
      g.fillRect(tile.chip[0], tile.chip[1], tile.chip[2] - tile.chip[0], tile.chip[3] - tile.chip[1]);
    }
    const inv = order >= 0 || (on && !chipped);
    g.save(); g.beginPath(); g.rect(x0, y0, w - pad, h); g.clip();
    g.fillStyle = inv ? T.invMute : T.mute;
    g.fillText(cat, tx, ty - lh);
    g.font = font;
    g.fillStyle = inv ? T.paper : T.ink;
    g.fillText(text, tx, ty);
    g.restore();
  }
  // your own words, drawn as ink on the page
  for (let k = 0; k < texts.length; k++) {
    const t = texts[k], size = t.size / S, x = t.x / S, y = t.y / S, lh = size * 1.15, lines = t.text.split('\n');
    g.font = size + 'px Newsreader, Georgia, serif';
    g.fillStyle = T.ink;
    let mw = 0;
    lines.forEach((ln, i) => { g.fillText(ln, x, y + i * lh); mw = Math.max(mw, g.measureText(ln).width); });
    t.box = [x * S, (y - size) * S, (x + mw) * S + 6, (y + (lines.length - 1) * lh + size * .3) * S];
    if (writing && k === activeText) {
      const cx = x + g.measureText(lines[lines.length - 1]).width + 2;
      g.fillRect(cx, y + (lines.length - 1) * lh - size * .78, Math.max(1, 1.5 / S), size * .95);
    }
  }
  page0 = g.getImageData(0, 0, W, H).data;
  eng.page.set(page0);
}

function theme() {
  return dark
    ? { paper: '#1b1b1a', ink: '#d8d6d0', line: '#323130', mute: '#6e6c68', invMute: 'rgba(27,27,26,.55)', inkRGB: [216, 214, 208], paperRGB: [27, 27, 26] }
    : { paper: '#e9e7e1', ink: '#2b2a28', line: '#d3d0c8', mute: '#8e8b84', invMute: 'rgba(233,231,225,.6)', inkRGB: [43, 42, 40], paperRGB: [233, 231, 225] };
}
function applyView() {
  document.documentElement.classList.toggle('dark', dark);
  syncView();
  if (eng) refresh();
}
let menuOpen = false, menuBeforeDock = false;
const cornerEl = document.getElementById('corner'), viewEl = document.getElementById('view');
function syncCorner() {
  const closing = panelOpen || infoOpen || menuOpen;
  cornerEl.innerHTML = closing ? '×' : '<span class="burger" aria-hidden="true"></span>';
  cornerEl.setAttribute('aria-label', panelOpen ? 'Close css' : infoOpen ? 'Close info' : menuOpen ? 'Close controls' : 'Open controls');
  cornerEl.setAttribute('aria-expanded', menuOpen);
  viewEl.hidden = !menuOpen || panelOpen || infoOpen;
}
function setMenu(open) { menuOpen = open; syncCorner(); }
cornerEl.addEventListener('click', () => {
  if (panelOpen) togglePanel(false);
  else if (infoOpen) setInfo(false);
  else setMenu(!menuOpen);
  syncCorner();
});
function syncView() {
  syncCorner();
  for (const b of document.querySelectorAll('#view button')) {
    const v = b.dataset.v;
    if (v === 'reset') continue;
    if (v === 'theme') { b.innerHTML = (dark ? 'dark' : 'light') + '<span class="key">' + (dark ? 'd / l' : 'l / d') + '</span>'; continue; }
    const on = { lines: showLines, labels: showLabels, image: !!baseImg && !baseVid, video: baseVid, freeze, write: writing, solo, new: creating, css: panelOpen && !creating, info: infoOpen }[v];
    b.setAttribute('aria-pressed', !!on);
  }
}
function setView(v) {
  if (v === 'new') { if (creating) endCreate(false); else startCreate(); return; }
  if (v === 'smaller' || v === 'bigger') { R = Math.max(4, Math.min(Math.min(W, H) / 2, R * (v === 'bigger' ? 1.2 : 1 / 1.2))); placeRing(); if (panelOpen && !exporting && !creating) cssEl.value = cssText(); return; }
  if (v === 'css') { togglePanel(!panelOpen); return; }
  if (v === 'info') { setInfo(!infoOpen); return; }
  if (v === 'reset') { stuck = []; eng.reset(); texts = []; activeText = -1; if (writing) typer.value = ''; refreshFlash(); refresh(); return; }
  if (v === 'image' || v === 'video') { if (v === 'image' ? baseImg && !baseVid : baseVid) clearBase(); else pickBase(v); return; }
  if (v === 'freeze') { freeze = !freeze; refresh(); return; }
  if (v === 'write') { setWriting(!writing); return; }
  if (v === 'solo') { solo = !solo; refresh(); return; }
  if (v === 'lines') showLines = !showLines;
  else if (v === 'labels') showLabels = !showLabels;
  else if (v === 'dark' || v === 'light' || v === 'theme') { const d = v === 'theme' ? !dark : v === 'dark'; if (d !== dark) { dark = d; refreshFlash(); } }
  applyView();
}
document.getElementById('view').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setView(b.dataset.v);
});
function copyRect(from, to, r) {
  for (let y = r[1]; y < r[3]; y++) to.set(from.subarray((y * W + r[0]) * 4, (y * W + r[2]) * 4), (y * W + r[0]) * 4);
}
/* live squares: a field of hairlines that turns to point at the cursor.
   hover = sparse lines, stuck = dense lines. on an image: a hairline frame only. */
function drawLive() {
  const px = (mx + panX) / S, py = my / S, page = eng.page, INK = theme().inkRGB;
  for (const tile of tiles) {
    if (!tile.live) continue;
    const [x0, y0, x1, y1] = tile.rect, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy) || 1;
    tile.ang.x += (dx / d - tile.ang.x) * .25; tile.ang.y += (dy / d - tile.ang.y) * .25;
    const al = Math.hypot(tile.ang.x, tile.ang.y) || 1, nx = -tile.ang.y / al, ny = tile.ang.x / al;
    copyRect(page0, page, tile.rect);
    if (baseImg) {
      const t = tile.stuck ? 3 : 1;
      for (let y = y0; y < y1 - 1; y++) for (let x = x0; x < x1 - 1; x++) {
        if (x - x0 >= t && x1 - 2 - x >= t && y - y0 >= t && y1 - 2 - y >= t) continue;
        const i = (y * W + x) * 4; page[i] = INK[0]; page[i + 1] = INK[1]; page[i + 2] = INK[2];
      }
    } else {
      // e-paper tone: a flat grey that deepens slightly on the side facing the cursor
      const PR = theme().paperRGB, hw = (x1 - x0) / 2 || 1, hh = (y1 - y0) / 2 || 1, ax = tile.ang.x / al, ay = tile.ang.y / al;
      const base = tile.stuck ? .34 : .12, lift = tile.stuck ? .16 : .1;
      for (let y = y0; y < y1 - 1; y++) for (let x = x0; x < x1 - 1; x++) {
        const f = ((x - cx) / hw * ax + (y - cy) / hh * ay) * .5 + .5, w = base + lift * (f < 0 ? 0 : f > 1 ? 1 : f);
        const i = (y * W + x) * 4;
        page[i] = PR[0] + (INK[0] - PR[0]) * w; page[i + 1] = PR[1] + (INK[1] - PR[1]) * w; page[i + 2] = PR[2] + (INK[2] - PR[2]) * w;
      }
    }
    if (tile.chip) copyRect(page0, page, tile.chip);
  }
}

/* ---------- state ---------- */

const tileAt = (x, y) => {
  if (x < 0 || y < 0 || x >= gw || y >= gh) return -1;
  const k = Math.floor(y / ch) * cols + Math.min(cols - 1, Math.floor(x / cw));
  return k < tiles.length ? k : -1;
};
function pipeline() {
  if (solo || hoverTile < 0) return stuck;
  const tile = tiles[hoverTile];
  return stuck.some(s => s.src === tile.key) ? stuck : stuck.concat(tileInsts(tile));
}
function toggleStick(tile) {
  if (stuck.some(s => s.src === tile.key)) stuck = stuck.filter(s => s.src !== tile.key);
  else stuck = stuck.concat(tileInsts(tile));
}
function refresh() {
  renderPage();
  syncView();
  holdEl.hidden = !(inside && pipeline().some(s => eng.EFFECTS[s.eff].name === 'conserve'));
  ringEl.classList.toggle('circle', lensShape === 'circle');
  ring2El.classList.toggle('circle', lensShape === 'circle');
  placeRing();
  if (panelOpen && !exporting && !creating && document.activeElement !== cssEl) cssEl.value = cssText();
}
function placeRing() {
  const h = R * S, w = R * S * aspect();
  for (const el of [ringEl, ring2El]) { el.style.width = w * 2 + 'px'; el.style.height = h * 2 + 'px'; }
  ringEl.style.transform = `translate(${mx - w}px, ${my - h}px)`;
}

/* ---------- info: the wiki ---------- */

const FAMILY_NOTES = {
  automata: 'Grids of cells that live and die by simple rules. Invent your own with @rule.',
  creatures: 'Agents that wander, seek, eat and multiply. Invent your own with @agent.',
  growth: 'Structures that branch and spread from the ink. Invent your own with @growth.',
  flow: 'The page moves like a fluid and keeps the marks. Invent your own with @field.',
  lens: 'Remap the space under the cursor, in the moment. Invent your own with @lens.',
  mark: 'Redraw the page in a medium: lines, dots, grain, print. Invent your own with @mark.',
  time: 'Memory: the page as it was, or everything that has passed.',
  ingredient: 'Do nothing alone. They change the one block right after them.',
  yours: 'Everything you invented.',
};
const esc = v => String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const code = t => '<pre><code>' + esc(t) + '</code></pre>';
function effectsHtml() {
  const fams = {};
  eng.EFFECTS.forEach(e => (fams[e.family] = fams[e.family] || []).push(e));
  return Object.keys(fams).map(f => '<h3>' + f + ' <span>' + fams[f].length + '</span></h3><p class="note">' + (FAMILY_NOTES[f] || '') + '</p><dl>'
    + fams[f].map(e => '<dt>' + esc(e.name) + '</dt><dd>' + esc(e.desc) + (Object.keys(e.params).length
      ? '<br><code>' + Object.keys(e.params).map(k => '--' + k + ': ' + esc(fmt(e.params[k]))).join(' · ') + '</code>' : '') + '</dd>').join('') + '</dl>').join('');
}
function wikiHtml() {
  const S2 = [
    ['start', 'Start', `
      <p class="lede">Petri is a growing lab of living effects. Every square in the grid holds one. Your cursor is the lens, the petri dish: hover a square and the dish takes on its effect, click and it sticks. Stuck effects run together, top to bottom, on whatever is under the lens: this page’s paper, lines and type, words you write, an image or a video.</p>
      <ol><li><b>Hover</b> to try an effect.</li><li><b>Click</b> to stick it. Click more to stack them. The order you click is the order they run.</li><li><b>Scroll</b> to resize the lens (pinch on a phone). Click a stuck square again to drop it.</li></ol>
      <p>Squares come in eight families. Six of them, automata, creatures, growth, flow, lens and mark, are things you can also invent yourself. Try <b>automata</b>, then <b>termites</b>, then press <b>f</b> to freeze.</p>`],
    ['toolbar', 'Toolbar', `<p>The button in the top-right corner opens the controls. While anything is open it turns into × and closes it. Every control shows its key on the right. Closing info or css brings the controls back if they were open. Info and css open over the grid without resizing it; scroll sideways to slide the page out from under them.</p><dl>
      <dt>grid (g)</dt><dd>Show the grid lines.</dd>
      <dt>labels (b)</dt><dd>Show every square’s name and family.</dd>
      <dt>light / dark (l, d)</dt><dd>One toggle. It says which paper you are on; L and D pick one directly.</dd>
      <dt>solo (s)</dt><dd>Hovering stops adding effects. Only stuck ones run, so you can roam with just them.</dd>
      <dt>freeze (f)</dt><dd>Every effect prints itself onto the page where the lens passes, so you paint with it, and nothing fades.</dd>
      <dt>text (t)</dt><dd>Press t and type: the words start where your cursor is. Click anywhere to start a new line there. While text is on every key types and the lens rests, so your words land cleanly; Esc leaves text mode and the effects pick up again. Your words become ink for the effects. Alt (Option on a Mac) with Up / Down resizes, Backspace on empty text deletes it.</dd>
      <dt>image (m)</dt><dd>Use your own picture as the page. You can also drop or paste one anywhere. Press again to clear it.</dd>
      <dt>video (v)</dt><dd>Use a video file as the page. It loops silently and every effect runs on the moving picture. Press again to clear it.</dd>
      <dt>new (n)</dt><dd>Build a new square and invent your own effects. See <a href="#w-squares">your squares</a>.</dd>
      <dt>css (c)</dt><dd>The stack as an editable recipe. See <a href="#w-recipes">recipes</a>.</dd>
      <dt>info (i)</dt><dd>This.</dd>
      <dt>reset (r)</dt><dd>Clears the stack, your words, every mark and every simulation.</dd></dl>`],
    ['effects', 'Effects', '<p>Every effect, by family, with its settings and their defaults. Change any setting in the css panel.</p>' + effectsHtml()],
    ['recipes', 'Recipes', `
      <p>The css panel shows your stack as a recipe. It looks like CSS, and it is also the file format the library reads. Blocks run top to bottom; reorder them to reorder the stack.</p>
      ${code(`.cursor {
  --radius: 60;      /* lens size in pixels */
  --shape: circle;   /* or rect */
}

.automata {
  --rule: B3/S23;
  --ink: #2b2a28;    /* any block can recolour itself */
}

.smear {
  --strength: speed * .2;   /* values can be math */
}`)}
      <h3>Settings every block takes</h3><dl>
      <dt>--ink, --paper</dt><dd>Any CSS colour: a name like <code>crimson</code>, hex, <code>rgb()</code> or <code>hsl()</code>. <code>auto</code> uses the theme. The block draws in these colours, and everything it touches inside the lens is recoloured from paper (light tones) to ink (dark tones). Set them to different colours, or you get a flat disc.</dd>
      <dt>--mix</dt><dd>0 to 1. How much of the effect to blend over what was under it.</dd>
      <dt>--scale</dt><dd>Lens size for this block only.</dd>
      <dt>--shape</dt><dd><code>circle</code>, <code>rect</code> or <code>inherit</code>.</dd>
      <dt>--falloff</dt><dd>0 to 1. Softens the lens edge.</dd>
      <dt>--spill</dt><dd>Where a living effect may show. <code>lens</code> (default): only inside the lens. <code>trail</code>: where your lens has been in the last ten seconds or so, so life follows your path. <code>free</code>: anywhere it wanders.</dd></dl>
      <h3>Math</h3><p>Any number can be an expression using <code>speed</code>, <code>t</code> (seconds), <code>x</code> and <code>y</code> (0 to 1 across the page), <code>vx</code>, <code>vy</code>, with <code>sin cos abs min max floor sqrt pow</code>. For example <code>--folds: 4 + floor(speed)</code>.</p>
      <h3>Ingredients</h3><p>mask, gate, trail and beat change the block right after them:</p>
      ${code(`.mask { --only: ink; }      /* next block only touches ink */
.kaleido {}

.gate { --when: still; }    /* fast, slow or still */
.spray {}

.trail { --delay: 40; }     /* follows where you were */
.automata {}

.beat { --bpm: 90; }        /* stop-motion */
.flock {}`)}
      <p>Put the caret on any number and press Up or Down to change it while it runs. Shift moves in tens, Alt (Option on a Mac) in tenths.</p>`],
    ['invent', 'Invent', `
      <p>Six kinds of invention, one for each family that grows or moves: automata, creatures, growth, flow, lens and mark. Define one with <code>@kind name { … }</code>, then use it like any block: <code>.name {}</code>. Inventions get their own squares when you save.</p>
      <h3>@rule: cellular automata</h3>${code(`@rule moss {
  --states: 4;        /* 2 = alive or dead; more leaves fading trails */
  --born: 3;          /* neighbour counts that wake a cell: 3, "3 6", "2-5" */
  --survive: 2-5;     /* neighbour counts that keep it alive */
  --range: 1;         /* 1 = the 8 around it; 2 to 8 = wider, like bosco */
  --neighbors: moore; /* or cross: only the 4 beside it */
  --seed: ink;        /* where cells start: ink, cursor or random */
  --cell: 3;          /* cell size in pixels */
  --every: 2;         /* frames per step */
  --shade: auto;      /* or one shade per state: "1 .6 .3" */
}`)}<p>Conway’s Life is <code>born 3, survive 2 3</code>. Brian’s Brain is <code>states 3, born 2, survive</code> left empty. Day &amp; Night is <code>born 3 6 7 8, survive 3 4 6 7 8</code>.</p>
      <h3>@agent: creatures</h3>${code(`@agent snail {
  --count: 12;
  --speed: 1;
  --turn: .3;       /* how much they wander */
  --seek: ink;      /* ink, paper or cursor */
  --avoid: trail;   /* trail, ink or paper */
  --trail: 1;       /* trail width; 0 for none */
  --shade: .8;
  --eat: no;        /* yes erases ink instead of drawing */
  --split: .01;     /* chance to branch each step */
  --life: 300;      /* steps before it dies */
  --spawn: ink;     /* where they appear: ink, paper or cursor */
}`)}
      <h3>@growth: branching structures</h3>${code(`@growth fern {
  --toward: up;     /* up, down, out, cursor, ink or none */
  --angle: 35;      /* branch angle in degrees */
  --split: .04;     /* chance to branch each step */
  --length: 120;    /* how far a branch grows */
  --wiggle: .15;
  --width: 1;
  --shade: .9;
  --seed: ink;      /* ink or cursor */
  --tips: 60;       /* growing tips at once */
}`)}
      <h3>@field: flows</h3>${code(`@field eddy {
  --toward: ink;    /* cursor, out, ink, up, down, left, right */
  --spin: .5;       /* swirl around the cursor; negative turns the other way */
  --strength: 1;
  --noise: .3;      /* turbulence */
  --scale: .02;     /* size of the turbulence */
}`)}<p>Fields move the page and leave marks, like smear.</p>
      <h3>@lens: remap space</h3>${code(`@lens prism {
  --folds: 6;       /* kaleidoscope folds; 0 for none */
  --mirror: none;   /* none, x, y or both */
  --twist: 2;       /* swirl, strongest at the centre */
  --spin: .3;       /* rotation over time */
  --zoom: .8;       /* below 1 magnifies */
  --repeat: 1;      /* tile the lens with copies */
  --wave: 0;        /* ripple strength */
  --pixel: 1;       /* block size */
}`)}<p>The steps run in this order: pixel, repeat, mirror, folds, twist and spin, zoom, wave.</p>
      <h3>@mark: draw the page in a medium</h3>${code(`@mark etch {
  --stroke: hatch;  /* line, hatch, cross, dot, stipple or grain */
  --size: 6;        /* spacing of the marks */
  --angle: 30;      /* in degrees */
  --follow: yes;    /* turn the strokes to follow shapes */
  --weight: 1;      /* how dark the tone reads */
  --jitter: 0;      /* hand-drawn wobble */
}`)}`],
    ['squares', 'Your squares', `
      <ol><li>Press <b>new (n)</b>. A starter recipe opens and runs on your cursor.</li>
      <li>Click squares in the grid to add them as blocks, edit the values, or invent something.</li>
      <li>Name it in <code>.square { --name: … }</code> and press <b>save</b>.</li></ol>
      <p>Your stack becomes a ★ square at the end of the grid. Each invention gets its own square under <b>yours</b>. <b>lock</b> in the css panel saves the current stack as a ★ square the same way. Right-click a ★ or yours square to delete it. Squares and inventions are kept in this browser. Words you type last only for the visit.</p>`],
    ['library', 'Library', `
      <p>Export (in the css panel) gives you three things:</p><dl>
      <dt>module</dt><dd><code>petri.js</code>, an ES module with every effect and the engine. Use it in your own projects.</dd>
      <dt>recipe</dt><dd>Your stack as a <code>.css</code> file. The module reads it, and you can paste it back into the panel.</dd>
      <dt>embed</dt><dd>One paste-in script for a plain website: mark any image, video or canvas with <code>data-petri</code>.</dd></dl>
      <h3>Any page</h3>${code(`import pipeline from './petri.js'

const recipe = await (await fetch('garden.css')).text()
const fx = pipeline(document.querySelector('canvas'), recipe)
fx.follow(document.querySelector('img'))`)}
      <h3>p5.js</h3>${code(`let fx
const out = document.querySelector('#out')   // a canvas the same size

function setup() {
  createCanvas(800, 600)
  fetch('garden.css').then(r => r.text()).then(r => fx = pipeline(out, r))
}
function draw() {
  background(235); textSize(140); text('hello', 80, 340)
  fx?.frame(drawingContext.canvas, { x: mouseX, y: mouseY })
}`)}
      <h3>Webcam, or any input</h3>${code(`const video = document.querySelector('video')
video.srcObject = await navigator.mediaDevices.getUserMedia({ video: true })
await video.play()

const fx = pipeline(canvas, recipe)
function loop() {
  fx.frame(video, { x, y })   // x, y can come from a fingertip, MIDI, OSC...
  requestAnimationFrame(loop)
}
loop()`)}
      <h3>API</h3><dl>
      <dt>pipeline(canvas, recipe, { keep, freeze, dark })</dt><dd>Draws into <code>canvas</code>. The recipe is text or a parsed recipe.</dd>
      <dt>fx.frame(source, { x, y, radius })</dt><dd>Runs one frame. <code>source</code> is an image, video, canvas or ImageData, or nothing to keep the last one. <code>x</code>, <code>y</code> are in canvas pixels; leave them out when there is no cursor.</dd>
      <dt>fx.follow(element)</dt><dd>Reads the element and follows the mouse over it. Returns a function that stops it.</dd>
      <dt>fx.setRecipe(css) · fx.reset() · fx.effects()</dt><dd>Swap recipes live, clear everything, list every effect and its settings.</dd>
      <dt>fx.freeze · fx.dark · fx.keep</dt><dd>The toolbar switches. keep holds marks without making every effect paint.</dd>
      <dt>parseRecipe(css)</dt><dd>Turns recipe text into <code>{ cursor, square, defs, blocks }</code>.</dd></dl>
      <p class="note">Effects work on pixels, so images must come from your own domain or send CORS headers. The module works on images, video and canvases, not on live page text and buttons. The e-ink look is part of this page, not the library.</p>`],
    ['keys', 'Keys', `<dl class="keys">
      <dt>g · b</dt><dd>grid, labels</dd><dt>l · d</dt><dd>light, dark</dd>
      <dt>s · f</dt><dd>solo, freeze</dd><dt>t · m · v</dt><dd>text, image, video</dd><dt>n · c · i</dt><dd>new, css, info</dd><dt>r</dt><dd>reset</dd><dt>esc</dt><dd>close info, css or the controls; otherwise clear the stack</dd>
      <dt>scroll · [ ]</dt><dd>lens size. On a phone or tablet, pinch, or use size in the menu.</dd><dt>sideways scroll</dt><dd>with info or css open, slides the page out from under the panel. Shift + scroll does the same.</dd><dt>Delete</dt><dd>drop the last stuck effect</dd><dt>space · esc</dt><dd>clear the stack</dd>
      <dt>Up · Down</dt><dd>in css, change the number under the caret. Shift for tens, Alt (Option on a Mac) for tenths.</dd></dl>`],
    ['inspo', 'Inspo', `
      <p>Well-known ideas some effects are built on, and the people who first described them.</p><dl>
      <dt>automata</dt><dd>Game of Life, John Conway, 1970.</dd>
      <dt>brain, wireworld</dt><dd>Brian’s Brain and Wireworld, Brian Silverman, 1987.</dd>
      <dt>bosco</dt><dd>Bosco’s rule, from Larger than Life, Kellie Evans.</dd>
      <dt>cyclic</dt><dd>Cyclic cellular automaton, David Griffeath.</dd>
      <dt>excite</dt><dd>Excitable media, James Greenberg and Stuart Hastings, 1978.</dd>
      <dt>cascade</dt><dd>Elementary cellular automata, numbered by Stephen Wolfram, 1983.</dd>
      <dt>sandpile</dt><dd>Abelian sandpile, Per Bak, Chao Tang and Kurt Wiesenfeld, 1987.</dd>
      <dt>lichen</dt><dd>Eden growth model, Murray Eden, 1961.</dd>
      <dt>voter</dt><dd>Voter model, Richard Holley and Thomas Liggett, 1975.</dd>
      <dt>ants</dt><dd>Langton’s ant, Chris Langton, 1986.</dd>
      <dt>termites</dt><dd>Termites, Mitchel Resnick, 1994.</dd>
      <dt>flock</dt><dd>Boids, Craig Reynolds, 1987.</dd>
      <dt>physarum</dt><dd>Physarum transport networks, Jeff Jones, 2010.</dd>
      <dt>coral</dt><dd>Diffusion-limited aggregation, Thomas Witten and Leonard Sander, 1981.</dd>
      <dt>hunt</dt><dd>Predator and prey dynamics, Alfred Lotka and Vito Volterra, 1920s.</dd>
      <dt>fireflies</dt><dd>Pulse-coupled synchrony, Renato Mirollo and Steven Strogatz, 1990.</dd>
      <dt>veins</dt><dd>Space colonization, Adam Runions and colleagues, 2005.</dd>
      <dt>substrate</dt><dd>Substrate, Jared Tarbell, 2003.</dd>
      <dt>flow</dt><dd>Curl noise, Robert Bridson and colleagues, 2007.</dd>
      <dt>hilbert</dt><dd>Hilbert curve, David Hilbert, 1891.</dd>
      <dt>quadtree</dt><dd>Quadtrees, Raphael Finkel and Jon Bentley, 1974.</dd>
      <dt>tectonic</dt><dd>Voronoi diagrams, Georgy Voronoy, 1908.</dd>
      <dt>droste</dt><dd>The Droste effect, named after the Droste cocoa tin.</dd></dl>
      <p class="credit">A <a href="https://maybemachines.com" target="_blank" rel="noopener">Maybe Machine</a> by <a href="https://ravipopat.info" target="_blank" rel="noopener">Ravi Popat</a>.</p>`],
  ];
  return {
    nav: S2.map(([id, t]) => '<button type="button" data-w="' + id + '">' + t.toLowerCase() + '</button>').join(''),
    body: S2.map(([id, t, body]) => '<section id="w-' + id + '"><h2>' + t + '</h2>' + body + '</section>').join(''),
  };
}
function sizeInfo() {}
function placeInfo() {}
const wnav = document.getElementById('wnav'), wbody = document.getElementById('wbody');
const goWiki = id => { const tgt = wbody.querySelector('#w-' + id); if (tgt) wbody.scrollTo({ top: wbody.scrollTop + tgt.getBoundingClientRect().top - wbody.getBoundingClientRect().top, behavior: 'smooth' }); };
document.getElementById('wikiClose').addEventListener('click', () => setInfo(false));
wnav.addEventListener('click', e => { const b = e.target.closest('button'); if (b) goWiki(b.dataset.w); });
function spyWiki() {
  let cur = null;
  const top = wbody.getBoundingClientRect().top;
  for (const sec of wbody.querySelectorAll('section')) if (sec.getBoundingClientRect().top - top < 40) cur = sec.id.slice(2);
  for (const b of wnav.querySelectorAll('button')) b.setAttribute('aria-current', b.dataset.w === (cur || 'start'));
}
wbody.addEventListener('scroll', spyWiki, { passive: true });
wbody.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#w-"]');
  if (a) { e.preventDefault(); goWiki(a.getAttribute('href').slice(3)); }
});
function setInfo(open) {
  if (open) { if (!panelOpen && !infoOpen) menuBeforeDock = menuOpen; menuOpen = false; }
  else if (!panelOpen) menuOpen = menuBeforeDock;
  if (open && panelOpen) { if (creating) endCreate(false); if (exporting) setExporting(false); panelOpen = false; panel.hidden = true; }
  infoOpen = open;
  if (open) { const w = wikiHtml(); wnav.innerHTML = w.nav; wbody.innerHTML = w.body; }
  infoEl.hidden = !open;
  if (open) { wbody.scrollTop = 0; spyWiki(); }
  relayout();
}

/* ---------- your own image as the page ---------- */

const fileEl = document.createElement('input');
fileEl.type = 'file'; fileEl.hidden = true;
document.body.appendChild(fileEl);
fileEl.addEventListener('change', () => { const f = fileEl.files[0]; if (f) (f.type.startsWith('video/') ? loadVideo : loadImage)(f); fileEl.value = ''; });
const vidEl = document.createElement('video');
vidEl.muted = true; vidEl.loop = true; vidEl.playsInline = true;
let baseVid = false;
function pickBase(kind) { fileEl.accept = kind === 'video' ? 'video/*' : 'image/*'; fileEl.click(); }
function clearBase() { baseImg = null; baseVid = false; vidEl.pause(); vidEl.removeAttribute('src'); eng.reset(); refresh(); }
function loadImage(file) {
  const url = URL.createObjectURL(file), im = new Image();
  im.onload = () => { vidEl.pause(); baseVid = false; baseImg = im; eng.reset(); refresh(); };
  im.src = url;
}
function loadVideo(file) {
  vidEl.src = URL.createObjectURL(file);
  vidEl.onloadeddata = () => { baseImg = vidEl; baseVid = true; eng.reset(); refresh(); };
  vidEl.play().catch(() => {});
}
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  const f = [...(e.dataTransfer.files || [])].find(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
  if (f) (f.type.startsWith('video/') ? loadVideo : loadImage)(f);
});
addEventListener('paste', e => {
  if (e.target === cssEl || e.target === typer) return;
  const it = [...(e.clipboardData ? e.clipboardData.items : [])].find(i => i.type.startsWith('image/'));
  if (it) { e.preventDefault(); loadImage(it.getAsFile()); }
});

/* ---------- css panel ---------- */

const fmt = v => typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : v;
function cssText() {
  let s = '/* runs top to bottom. values can be numbers,\n   colors, words, or math using speed, t, x, y. */\n\n';
  s += '.cursor {\n  --radius: ' + Math.round(R) + ';\n  --shape: ' + lensShape + ';\n}\n';
  const shown = new Set();
  for (const inst of stuck) {
    const e = eng.EFFECTS[inst.eff];
    if (!e.custom || shown.has(e.name)) continue;
    shown.add(e.name);
    const d = specOf(e.name);
    s += '\n@' + e.custom + ' ' + e.name + ' {\n' + Object.keys(d).map(k => '  --' + k + ': ' + fmt(d[k]) + ';\n').join('') + '}\n';
  }
  for (const inst of stuck) {
    const e = eng.EFFECTS[inst.eff];
    s += '\n.' + e.name + ' {\n  /* ' + e.desc + ' */\n';
    for (const k in e.params) if (!e.custom || inst.p[k] !== e.params[k]) s += '  --' + k + ': ' + fmt(k in inst.p ? inst.p[k] : e.params[k]) + ';\n';
    if (!e.twin) for (const k in eng.COMMON) if (advanced || k === 'ink' || (k in inst.p && inst.p[k] !== eng.COMMON[k])) s += '  --' + k + ': ' + fmt(k in inst.p ? inst.p[k] : eng.COMMON[k]) + ';\n';
    s += '}\n';
  }
  if (!stuck.length) s += '\n/* nothing stuck yet. click a square,\n   or type .automata {} here.\n   press new (n) to invent your own. */\n';
  if (advanced) s += '\n/* every block also takes:\n   --ink, --paper any css colour, or auto\n   --mix 0–1      blend with what was under it\n   --scale        lens size for this block only\n   --shape        rect, circle or inherit\n   --falloff 0–1  soften the lens edge */\n';
  return s;
}
const specOf = name => (liveDefs[name] || defs.find(d => d.name === name) || { spec: {} }).spec;
function props(body) {
  const out = {};
  body.replace(/--([\w-]+)\s*:\s*([^;]+);?/g, (_, k, v) => {
    v = v.trim();
    out[k] = /^-?\d*\.?\d+$/.test(v) ? parseFloat(v) : v.replace(/^["']|["']$/g, '');
  });
  return out;
}
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '');
function parseCss(text) {
  const clean = stripComments(text).replace(/@(rule|agent|growth|field|lens|mark)\s+[\w-]+\s*\{[^}]*\}/g, ''), re = /\.([\w-]+)\s*\{([^}]*)\}/g, blocks = [];
  let m;
  while ((m = re.exec(clean))) blocks.push({ name: m[1], props: props(m[2]) });
  return blocks;
}
function parseDefs(text) {
  const re = /@(rule|agent|growth|field|lens|mark)\s+([\w-]+)\s*\{([^}]*)\}/g, out = [];
  let m;
  while ((m = re.exec(stripComments(text)))) out.push({ kind: m[1], name: m[2], spec: props(m[3]) });
  return out;
}
function persistDefsFor(stack) {
  let changed = false;
  for (const s of stack) {
    const e = eng.EFFECTS[s.eff];
    if (!e.custom) continue;
    const d = { kind: e.custom, name: e.name, spec: specOf(e.name) }, k = defs.findIndex(x => x.name === e.name);
    if (k >= 0) defs[k] = d; else defs.push(d);
    changed = true;
  }
  if (changed) saveDefs();
}
let statusTimer;
function setStatus(msg, err) {
  clearTimeout(statusTimer);
  statusEl.hidden = !msg;
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('err', !!err);
  if (msg && !err) statusTimer = setTimeout(() => { statusEl.hidden = true; }, 2600);
}
function applyCss() {
  const unknown = [], next = [], used = new Set(), bad = [];
  for (const d of parseDefs(cssEl.value)) {
    const err = eng.define(d.kind, d.name, d.spec);
    if (err) bad.push(err); else liveDefs[d.name] = { kind: d.kind, spec: d.spec };
  }
  for (const b of parseCss(cssEl.value)) {
    if (b.name === 'square') { squareName = String(b.props.name || '').trim(); continue; }
    if (b.name === 'cursor') {
      if (+b.props.radius > 0) R = Math.max(4, Math.min(Math.min(W, H) / 2, +b.props.radius));
      if (b.props.shape === 'circle' || b.props.shape === 'rect') lensShape = b.props.shape;
      continue;
    }
    if (!(b.name in eng.BY_NAME)) { unknown.push('.' + b.name); continue; }
    const e = eng.BY_NAME[b.name], p = defaults(e);
    for (const k in b.props) if (k in p || k in eng.COMMON) p[k] = b.props[k];
    const k = stuck.findIndex((s, i) => s.eff === e && !used.has(i));
    if (k >= 0) used.add(k);
    next.push({ eff: e, p, src: k >= 0 ? stuck[k].src : keyOf(e) });
  }
  stuck = next;
  refresh();
  if (bad.length) setStatus(bad[0], true);
  else if (unknown.length) setStatus('unknown: ' + unknown.join(' ') + '. use any square’s name, or define it with @rule or @agent.', true);
  else setStatus('');
}
let cssTimer;
cssEl.addEventListener('input', () => { if (exporting) return; clearTimeout(cssTimer); cssTimer = setTimeout(applyCss, 220); });
cssEl.addEventListener('blur', () => { if (!exporting && !creating && !statusEl.classList.contains('err')) cssEl.value = cssText(); });
/* caret on a number: up / down change it. shift = ×10, alt = ÷10 */
function nudgeNumber(dir, e) {
  const txt = cssEl.value, pos = cssEl.selectionStart;
  if (pos !== cssEl.selectionEnd) return false;
  const ls = txt.lastIndexOf('\n', pos - 1) + 1, le = txt.indexOf('\n', pos), line = txt.slice(ls, le < 0 ? txt.length : le);
  if (!/^\s*--/.test(line)) return false;
  const re = /-?\d*\.?\d+/g;
  let m;
  while ((m = re.exec(line))) {
    const a = ls + m.index, b = a + m[0].length;
    if (pos < a || pos > b) continue;
    let dec = (m[0].split('.')[1] || '').length, step = dec ? Math.pow(10, -dec) : 1;
    if (e.shiftKey) step *= 10;
    if (e.altKey) { step /= 10; dec += 1; }
    const str = (parseFloat(m[0]) + dir * step).toFixed(Math.max(0, dec)).replace(/^(-?)0\./, '$1.');
    cssEl.value = txt.slice(0, a) + str + txt.slice(b);
    const caret = Math.min(a + str.length, a + (pos - a));
    cssEl.setSelectionRange(caret, caret);
    clearTimeout(cssTimer);
    applyCss();
    return true;
  }
  return false;
}
cssEl.addEventListener('keydown', e => {
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !exporting && nudgeNumber(e.key === 'ArrowUp' ? 1 : -1, e)) { e.preventDefault(); return; }
  if (e.key === 'Tab' && !exporting) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  if (e.key === 'Escape') cssEl.blur();
});

function exportCode() {
  const cfg = {
    radius: Math.round(R * S), aspect: +aspect().toFixed(3), shape: lensShape,
    stack: stuck.map(s => Object.assign({ effect: eng.EFFECTS[s.eff].name }, s.p)),
    defs: [...new Set(stuck.map(s => eng.EFFECTS[s.eff]).filter(e => e.custom).map(e => e.name))].map(n => ({ kind: eng.EFFECTS[eng.BY_NAME[n]].custom, name: n, spec: specOf(n) })),
  };
  return '/* Petri export\n'
    + '   1. Paste this in a <script> before </body>.\n'
    + '   2. Add data-petri to any <img>, <video> or <canvas>.\n'
    + '   Images must come from your own domain (or send CORS headers),\n'
    + '   otherwise the browser will not let the script read their pixels. */\n'
    + '(() => {\n'
    + 'const CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n'
    + 'const createPipeline = ' + createPipeline.toString() + ';\n'
    + '(' + petriAdapter.toString() + ')(CONFIG, createPipeline);\n'
    + '})();\n';
}
let creating = false, beforeCreate = null, squareName = '';
const saveBtn = document.getElementById('save'), cancelBtn = document.getElementById('cancel');
const TEMPLATE = `/* build your own square.
   stack blocks in the order they run, and click any
   square in the grid to add it. put the caret on a
   number and press Up or Down to change it. it runs on
   your cursor while you edit. */

.square {
  --name: my garden;
}

/* invent an automaton. born and survive are neighbour
   counts (3, 2 3, or 2-5). states above 2 leave fading
   trails. range widens the neighbourhood. seed: ink,
   cursor or random. */
@rule moss {
  --states: 4;
  --born: 3;
  --survive: 2-5;
  --range: 1;
  --seed: ink;
}

/* invent agents. seek and avoid: ink, paper, trail or
   cursor. eat: yes erases ink instead of drawing.
   there is also @growth, @field, @lens and @mark:
   info → invent has every setting. */
@agent snail {
  --count: 12;
  --seek: ink;
  --avoid: trail;
  --trail: 1;
  --split: .01;
}

.moss {
}

.snail {
}
`;
function setCreateUI(on) {
  creating = on;
  titleEl.textContent = on ? 'new square' : 'cursor.css';
  saveBtn.hidden = cancelBtn.hidden = !on;
  lockBtn.hidden = exportBtn.hidden = on;
  refresh();
}
function startCreate() {
  if (creating) { cssEl.focus(); return; }
  if (exporting) setExporting(false);
  beforeCreate = stuck.slice();
  if (!panelOpen) togglePanel(true);
  setCreateUI(true);
  cssEl.value = TEMPLATE;
  applyCss();
  setStatus('edit the blocks, then save to add it to the grid');
  cssEl.focus();
}
function endCreate(keepStack) {
  if (!creating) return;
  if (!keepStack) stuck = beforeCreate || [];
  setCreateUI(false);
  cssEl.value = cssText();
}
saveBtn.addEventListener('click', () => {
  applyCss();
  if (!stuck.length) { setStatus('add at least one effect block first', true); return; }
  const names = stuck.map(s => eng.EFFECTS[s.eff].name);
  const name = squareName || (names.length > 3 ? names.slice(0, 3).join('+') + '+' + (names.length - 3) : names.join('+'));
  persistDefsFor(stuck);
  const id = Date.now().toString(36);
  customs.push({ id, name, blocks: stuck.map(s => ({ e: eng.EFFECTS[s.eff].name, p: Object.assign({}, s.p) })) });
  saveCustoms();
  creating = false;
  relayout();
  const tile = tiles.find(t => t.key === 'c' + id);
  stuck = tile ? tileInsts(tile) : [];
  setCreateUI(false);
  cssEl.value = cssText();
  setStatus('saved ★ ' + name + ' to the grid' + (stuck.some(s => eng.EFFECTS[s.eff].custom) ? ', with your inventions as their own squares' : ''));
});
cancelBtn.addEventListener('click', () => { endCreate(false); setStatus('cancelled'); });

let exportMode = 'module';
const exTabs = { module: document.getElementById('exModule'), recipe: document.getElementById('exRecipe'), embed: document.getElementById('exEmbed') };
function moduleCode() {
  const name = (squareName || 'my-recipe').replace(/\s+/g, '-').toLowerCase();
  return '/* petri.js, an ES module.\n\n'
    + '   import pipeline from \'./petri.js\'\n\n'
    + '   const recipe = await (await fetch(\'' + name + '.css\')).text()   // the recipe tab\n'
    + '   const fx = pipeline(canvas, recipe)\n\n'
    + '   // drive it yourself, every frame. source can be an image, video,\n'
    + '   // canvas (a p5 or three.js sketch) or ImageData. x, y in canvas pixels:\n'
    + '   fx.frame(source, { x, y })\n\n'
    + '   // or let it follow the mouse over an element:\n'
    + '   fx.follow(document.querySelector(\'img\'))\n\n'
    + '   fx.keep = true      // marks stay\n'
    + '   fx.freeze = true    // every effect paints onto the page\n'
    + '   fx.dark = true      // light ink on dark paper\n'
    + '   fx.setRecipe(css)   // swap recipes live\n'
    + '   fx.effects()        // every effect, its family and settings\n'
    + '   fx.reset()\n\n'
    + '   Images must come from your own domain (or send CORS headers). */\n\n'
    + 'const createPipeline = ' + createPipeline.toString() + ';\n\n'
    + 'const parseRecipe = ' + parseRecipe.toString() + ';\n\n'
    + 'const pipeline = (' + pipelineFactory.toString() + ')(createPipeline, parseRecipe);\n\n'
    + 'export { pipeline, parseRecipe, createPipeline };\nexport default pipeline;\n';
}
function recipeCode() {
  return '/* a Petri recipe. load it with pipeline(canvas, recipe),\n   or paste it into the css panel. */\n\n' + cssText().replace(/^\/\*[\s\S]*?\*\/\s*/, '');
}
function showExport(mode) {
  exportMode = mode;
  for (const k in exTabs) exTabs[k].setAttribute('aria-pressed', k === mode);
  titleEl.textContent = mode === 'module' ? 'petri.js' : mode === 'recipe' ? 'recipe.css' : 'embed.js';
  cssEl.value = mode === 'module' ? moduleCode() : mode === 'recipe' ? recipeCode() : exportCode();
  setStatus(mode === 'module' ? 'the library: an ES module for your own projects. pair it with the recipe.'
    : mode === 'recipe' ? 'your stack as a file. load it with the module, or paste it back into css.'
    : 'one paste-in script: add data-petri to an <img>, <video> or <canvas>.');
}
function setExporting(on) {
  if (on && !stuck.length) { setStatus('stick at least one effect to export it', true); return; }
  exporting = on;
  cssEl.readOnly = on;
  exportBtn.textContent = on ? 'back' : 'export';
  copyBtn.hidden = !on; advBtn.hidden = on; lockBtn.hidden = on;
  for (const k in exTabs) exTabs[k].hidden = !on;
  if (on) showExport(exportMode);
  else { titleEl.textContent = 'cursor.css'; cssEl.value = cssText(); setStatus(''); }
}
for (const k in exTabs) exTabs[k].addEventListener('click', () => showExport(k));
function togglePanel(open) {
  if (open) { if (!panelOpen && !infoOpen) menuBeforeDock = menuOpen; menuOpen = false; }
  else if (!infoOpen) menuOpen = menuBeforeDock;
  if (!open && creating) endCreate(false);
  if (open && infoOpen) { infoOpen = false; infoEl.hidden = true; }
  panelOpen = open;
  panel.hidden = !open;
  if (!open && exporting) setExporting(false);
  relayout();
  if (open) { cssEl.value = cssText(); setStatus(dockW ? 'scroll sideways to slide the page out from under this panel' : ''); }
}
document.getElementById('close').addEventListener('click', () => togglePanel(false));
advBtn.addEventListener('click', () => {
  advanced = !advanced;
  advBtn.setAttribute('aria-pressed', advanced);
  cssEl.value = cssText();
});
exportBtn.addEventListener('click', () => setExporting(!exporting));
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(cssEl.value).then(() => setStatus('copied'), () => { cssEl.select(); setStatus('selected. press Cmd+C (Ctrl+C on Windows) to copy'); });
});
lockBtn.addEventListener('click', () => {
  if (document.activeElement === cssEl) applyCss();
  if (!stuck.length) { setStatus('stick at least one effect first', true); return; }
  const names = stuck.map(s => eng.EFFECTS[s.eff].name);
  const name = names.length > 3 ? names.slice(0, 3).join('+') + '+' + (names.length - 3) : names.join('+');
  persistDefsFor(stuck);
  customs.push({ id: Date.now().toString(36), name, blocks: stuck.map(s => ({ e: eng.EFFECTS[s.eff].name, p: Object.assign({}, s.p) })) });
  saveCustoms();
  relayout();
  setStatus('saved ★ ' + name + ' to the grid');
});

/* ---------- write: your own words on the page ---------- */

const typer = document.createElement('textarea');
typer.id = 'typer'; typer.setAttribute('aria-label', 'Text on the page'); typer.spellcheck = false;
document.body.appendChild(typer);
function showWords() {
  refresh();
  const t = texts[activeText];
  if (t && t.box) eng.clearMarks(t.box[0] / S - 2, t.box[1] / S - 2, t.box[2] / S + 4, t.box[3] / S + 4);
}
function setWriting(on) {
  writing = on;
  if (!on) {
    typer.blur();
    texts = texts.filter(t => t.text.trim());
    activeText = -1;
    saveTexts();
  }
  refresh();
}
const hitText = (x, y) => texts.findIndex(t => t.box && x >= t.box[0] - 6 && x <= t.box[2] + 6 && y >= t.box[1] - 6 && y <= t.box[3] + 6);
function placeText(x, y) {
  const hit = hitText(x, y), keepT = hit >= 0 ? texts[hit] : null;
  texts = texts.filter(t => t.text.trim() || t === keepT);
  if (keepT) activeText = texts.indexOf(keepT);
  else { texts.push({ x, y: y + textSize * .35, size: textSize, text: '' }); activeText = texts.length - 1; }
  typer.value = texts[activeText].text;
  typer.focus();
  typer.setSelectionRange(typer.value.length, typer.value.length);
  refresh();
}
typer.addEventListener('input', () => {
  if (activeText < 0) return;
  texts[activeText].text = typer.value;
  saveTexts();
  showWords();
});
typer.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); setWriting(false); return; }
  if (activeText < 0) return;
  const t = texts[activeText];
  if (e.key === 'Backspace' && (!typer.value || e.metaKey || e.ctrlKey)) {
    e.preventDefault(); texts.splice(activeText, 1); activeText = -1; saveTexts(); refresh(); return;
  }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    t.size = textSize = Math.max(10, Math.min(240, t.size + (e.key === 'ArrowUp' ? 4 : -4)));
    saveTexts(); refresh();
  }
});

/* ---------- input ---------- */

const inPanel = e => {
  const path = e.composedPath ? e.composedPath() : [e.target];
  return path.includes(cornerEl) || (menuOpen && path.includes(viewEl)) || path.includes(viewEl) && !viewEl.hidden
    || (panelOpen && path.includes(panel)) || (infoOpen && path.includes(infoEl));
};
function leaveGrid() {
  if (!inside && hoverTile < 0) return;
  inside = false; hoverTile = -1; ringEl.hidden = true; refresh();
}
addEventListener('pointermove', e => {
  if (inPanel(e)) { leaveGrid(); return; }
  mx = e.clientX; my = e.clientY;
  const k = tileAt(mx + panX, my);
  if (k < 0) { leaveGrid(); return; }
  if (!inside) { inside = true; ringEl.hidden = false; }
  if (k !== hoverTile) { hoverTile = k; refresh(); }
  placeRing();
  placeInfo();
});
document.documentElement.addEventListener('pointerleave', leaveGrid);
addEventListener('click', e => {
  if (inPanel(e) || pinched) { pinched = false; return; }
  if (writing) { placeText(e.clientX + panX, e.clientY); return; }
  const k = tileAt(e.clientX + panX, e.clientY);
  if (k < 0) return;
  const tile = tiles[k];
  if (tile.kind === 'css') togglePanel(!panelOpen);
  else if (tile.kind === 'info') { mx = e.clientX; my = e.clientY; setInfo(true); }
  else if (tile.kind === 'image') { if (baseImg) { baseImg = null; eng.reset(); refresh(); } else fileEl.click(); }
  else if (tile.kind === 'keep') { keep = !keep; refresh(); }
  else if (tile.kind === 'solo') { solo = !solo; refresh(); }
  else if (tile.kind === 'add') startCreate();
  else if (creating && tile.kind === 'effect') { cssEl.value = cssEl.value.replace(/\s*$/, '') + '\n\n.' + tile.name + ' {\n}\n'; applyCss(); }
  else if (isFx(tile)) { toggleStick(tile); refresh(); }
});
addEventListener('contextmenu', e => {
  const k = tileAt(e.clientX + panX, e.clientY);
  if (k >= 0 && tiles[k].key.startsWith('d:')) {
    e.preventDefault();
    const name = tiles[k].name;
    defs = defs.filter(d => d.name !== name); delete liveDefs[name]; saveDefs();
    stuck = stuck.filter(s => eng.EFFECTS[s.eff].name !== name);
    const keepStuck = stuck.map(s => ({ name: eng.EFFECTS[s.eff].name, p: s.p, src: s.src }));
    eng = null; setup();
    stuck = keepStuck.filter(s => s.name in eng.BY_NAME).map(s => ({ eff: eng.BY_NAME[s.name], p: s.p, src: s.src }));
    refresh();
    return;
  }
  if (k < 0 || tiles[k].kind !== 'custom') return;
  e.preventDefault();
  const key = tiles[k].key;
  stuck = stuck.filter(s => s.src !== key);
  customs = customs.filter(c => 'c' + c.id !== key);
  saveCustoms();
  relayout();
});
addEventListener('wheel', e => {
  if (inPanel(e)) return;
  e.preventDefault();
  if ((panelOpen || infoOpen) && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) { setPan(panX + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)); return; }
  R = Math.max(4, Math.min(Math.min(W, H) / 2, R * (e.deltaY > 0 ? .92 : 1.08)));
  placeRing();
  if (panelOpen && !exporting && !creating && document.activeElement !== cssEl) cssEl.value = cssText();
}, { passive: false });
addEventListener('keydown', e => {
  if (e.target === cssEl || e.target === typer) return;
  if (writing) {
    if (e.key === 'Escape') { e.preventDefault(); setWriting(false); return; }
    if (e.metaKey || e.ctrlKey) return;
    if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') {
      e.preventDefault();
      if (activeText < 0) { if (e.key === 'Backspace') return; placeText(inside ? mx + panX : gw / 2, inside ? my : gh / 2); }
      const t = texts[activeText];
      if (e.key === 'Backspace') t.text = t.text.slice(0, -1); else t.text += e.key === 'Enter' ? '\n' : e.key;
      typer.value = t.text;
      typer.focus();
      showWords();
    }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'backspace') stuck = stuck.slice(0, -1);
  else if (k === 'escape') { if (infoOpen) { setInfo(false); return; } if (panelOpen) { togglePanel(false); return; } if (menuOpen) { setMenu(false); return; } stuck = []; }
  else if (k === ' ') stuck = [];
  else if (e.metaKey || e.ctrlKey || e.altKey) return;
  else if (k === 's') solo = !solo;
  else if (k === 'f') freeze = !freeze;
  else if (k === 'g') { setView('lines'); return; }
  else if (k === 'b') { setView('labels'); return; }
  else if (k === 'l') { setView('light'); return; }
  else if (k === 'd') { setView('dark'); return; }
  else if (k === 'm') { e.preventDefault(); setView('image'); return; }
  else if (k === 't') { e.preventDefault(); setWriting(true); if (inside) placeText(mx + panX, my); return; }
  else if (k === 'n') { e.preventDefault(); setView('new'); return; }
  else if (k === 'v') { e.preventDefault(); setView('video'); return; }
  else if (k === 'r') { setView('reset'); return; }
  else if (k === '[') R = Math.max(4, R * .85);
  else if (k === ']') R = Math.min(Math.min(W, H) / 2, R * 1.15);
  else if (k === 'c') { e.preventDefault(); togglePanel(!panelOpen); return; }
  else if (k === 'i') { setInfo(!infoOpen); return; }
  else return;
  e.preventDefault();
  refresh();
});
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(setup, 150); });

/* ---------- touch: pinch to resize the lens ---------- */

const touches = new Map();
let pinch0 = null, pinched = false;
addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, R }; }
});
addEventListener('pointermove', e => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch0 && touches.size === 2) {
    const [a, b] = [...touches.values()];
    R = Math.max(4, Math.min(Math.min(W, H) / 2, pinch0.R * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch0.d));
    placeRing();
  }
});
const endTouch = e => { touches.delete(e.pointerId); if (touches.size < 2 && pinch0) { pinch0 = null; pinched = true; setTimeout(() => { pinched = false; }, 400); } };
addEventListener('pointerup', endTouch);
addEventListener('pointercancel', endTouch);

/* ---------- loop ---------- */

/* e-ink output: 16 grey steps per channel with an ordered dither, a fixed paper grain,
   ghosts of recent dark marks, and an inverted flash on full refresh */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + .5) / 16);
let grain = null, ghost = null, flash = 0, out = null, out32 = null, prev32 = null, outKey = '';
function einkPass(src) {
  const n = W * H;
  if (!out || out.length !== n * 4) {
    grain = new Int8Array(n); ghost = new Float32Array(n);
    for (let k = 0; k < n; k++) grain[k] = (Math.random() - .5) * 7;
    out = new Uint8ClampedArray(n * 4); out32 = new Uint32Array(out.buffer);
    prev32 = new Uint32Array(n);
    imgData = new ImageData(out, W, H);
    outKey = '';
  }
  const T = theme(), pr = T.paperRGB, ir = T.inkRGB, pl = (pr[0] * 3 + pr[1] * 6 + pr[2]) / 10, il = (ir[0] * 3 + ir[1] * 6 + ir[2]) / 10;
  const span = pl - il, inv = flash > 0, key = dark + ':' + inv, full = key !== outKey;
  outKey = key;
  const src32 = new Uint32Array(src.buffer, src.byteOffset, n);
  for (let y = 0, k = 0; y < H; y++) {
    const brow = (y & 3) * 4;
    for (let x = 0; x < W; x++, k++) {
      const raw = src32[k];
      if (!full && raw === prev32[k] && ghost[k] === 0) continue;
      prev32[k] = raw;
      const i = k * 4, l = (src[i] * 3 + src[i + 1] * 6 + src[i + 2]) / 10;
      let dist = (pl - l) / span; dist = dist < 0 ? 0 : dist > 1 ? 1 : dist;
      let gh = ghost[k] * .93;
      if (gh < .02) gh = 0;
      ghost[k] = dist > gh ? (dist > .02 ? dist : 0) : gh;
      const extra = gh > dist ? (gh - dist) * .2 : 0, th = BAYER4[brow + (x & 3)], gr = grain[k];
      for (let c = 0; c < 3; c++) {
        let v = src[i + c] + (ir[c] - src[i + c]) * extra + gr;
        v = Math.floor(v / 17 + th) * 17;
        out[i + c] = inv ? 255 - v : v;
      }
      out[i + 3] = 255;
    }
  }
  if (flash > 0) flash--;
}
function refreshFlash() { flash = 3; }

function tick() {
  try {
    if (baseVid && vidEl.readyState >= 2 && !vidEl.paused) renderPage();
    drawLive();
    eng.frame(pipeline(), (mx + panX) / S, my / S, { R, aspect: aspect(), shape: lensShape, keep: keep || freeze, bakeAll: freeze, dark, active: !writing && (inside || stuck.length > 0) });
    einkPass(eng.buf);
    ctx.putImageData(imgData, 0, 0);
    const P = eng.P;
    ring2El.hidden = P.twinX == null;
    if (P.twinX != null) {
      const h = R * S, w = R * S * aspect();
      ring2El.style.transform = `translate(${P.twinX * S - w}px, ${P.twinY * S - h}px)`;
    }
    if (!holdEl.hidden) {
      const hd = P.held, m = Math.max(hd[0], hd[1], hd[2], 1), size = 8 + Math.min(20, Math.log10(hd[0] + hd[1] + hd[2] + 1) * 3);
      holdEl.style.width = holdEl.style.height = size + 'px';
      holdEl.style.background = `rgb(${hd[0] / m * 255},${hd[1] / m * 255},${hd[2] / m * 255})`;
      holdEl.style.transform = `translate(${mx + R * S * aspect() * .8}px, ${my + R * S * .8}px)`;
    }
  } catch (err) {
    console.error(err);
  }
  requestAnimationFrame(tick);
}

function makeGrain() {
  try {
    const g = document.createElement('canvas'); g.width = g.height = 96;
    const c = g.getContext('2d'), d = c.createImageData(96, 96);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() < .5 ? 0 : 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = Math.random() * 14; }
    c.putImageData(d, 0, 0);
    document.documentElement.style.setProperty('--grain', 'url(' + g.toDataURL() + ')');
  } catch (e) {}
}
const start = () => { makeGrain(); setup(); applyView(); requestAnimationFrame(tick); };
const fontsReady = document.fonts ? Promise.race([
  Promise.all([document.fonts.load('11px "JetBrains Mono"'), document.fonts.load('700 11px "JetBrains Mono"'), document.fonts.load('40px Newsreader')]),
  new Promise(r => setTimeout(r, 1500)),
]) : Promise.resolve();
fontsReady.then(start, start);
})();
