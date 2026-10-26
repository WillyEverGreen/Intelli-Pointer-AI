/* Selection overlay: paints the frozen screenshot and lets the user mark
   regions (rect, square, ellipse, lasso) and annotate (pen, arrow, highlight,
   blur). All coordinates in `ops` are CSS pixels of this window; `k` converts
   to physical screenshot pixels. Nothing here touches the real desktop. */
(() => {
  const view = document.getElementById('view');
  const vctx = view.getContext('2d');
  const toolbar = document.getElementById('toolbar');
  const maskBtn = document.getElementById('mask');
  const widthInput = document.getElementById('width');

  const SELECTION_TOOLS = new Set(['rect', 'square', 'ellipse', 'lasso']);
  const HANDLE = 9;

  let base = null; // canvas holding the full-resolution screenshot
  let k = 1; // physical px per CSS px
  let ops = [];
  let undoStack = [];
  let redoStack = [];
  let tool = 'rect';
  let color = '#e5484d';
  const ACCENT = '#2f7bf5';
  let drag = null; // in-progress interaction
  let dirty = true;
  let active = false;

  // ---------- setup ----------

  window.ipApplyIcons();
  for (const b of document.querySelectorAll('.swatch')) b.style.setProperty('--c', b.dataset.color);

  const quick = document.getElementById('quick');
  for (const a of window.IP_ACTIONS.filter((x) => ['explain', 'summarize', 'fix'].includes(x.id))) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = a.label;
    b.title = `Send immediately: "${a.prompt}"`;
    b.addEventListener('click', () => confirm(a.id));
    quick.appendChild(b);
  }

  function setTool(t) {
    tool = t;
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
  }
  function setColor(c) {
    color = c;
    for (const b of document.querySelectorAll('.swatch')) b.classList.toggle('active', b.dataset.color === c);
  }
  setTool('rect');
  setColor(color);

  document.getElementById('tools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (b) setTool(b.dataset.tool);
  });
  for (const b of document.querySelectorAll('.swatch')) b.addEventListener('click', () => setColor(b.dataset.color));
  document.getElementById('undo').addEventListener('click', undo);
  document.getElementById('redo').addEventListener('click', redo);
  document.getElementById('clear').addEventListener('click', () => mutate(() => { ops = []; }));
  document.getElementById('ask').addEventListener('click', () => confirm(null));
  document.getElementById('cancel').addEventListener('click', () => window.overlay.cancel());
  const maskOn = () => maskBtn.getAttribute('aria-pressed') === 'true';
  function toggleMask() {
    maskBtn.setAttribute('aria-pressed', String(!maskOn()));
    dirty = true;
  }
  maskBtn.addEventListener('click', toggleMask);

  // ---------- history ----------

  function mutate(fn) {
    undoStack.push(JSON.stringify(ops));
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    fn();
    dirty = true;
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(ops));
    ops = JSON.parse(undoStack.pop());
    dirty = true;
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(ops));
    ops = JSON.parse(redoStack.pop());
    dirty = true;
  }

  // ---------- geometry ----------

  const regions = () => ops.filter((o) => o.type === 'region');

  function bboxOf(op) {
    if (op.points) {
      const xs = op.points.map((p) => p[0]);
      const ys = op.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    return { x: op.x, y: op.y, w: op.w, h: op.h };
  }

  function normBox(x1, y1, x2, y2, square) {
    let w = x2 - x1;
    let h = y2 - y1;
    if (square) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    return { x: Math.min(x1, x1 + w), y: Math.min(y1, y1 + h), w: Math.abs(w), h: Math.abs(h) };
  }

  // Works on a CanvasRenderingContext2D or a Path2D.
  function shapePath(ctx, op, s = 1, ox = 0, oy = 0) {
    if (ctx.beginPath) ctx.beginPath();
    if (op.shape === 'lasso') {
      op.points.forEach(([x, y], i) => (i ? ctx.lineTo((x - ox) * s, (y - oy) * s) : ctx.moveTo((x - ox) * s, (y - oy) * s)));
      ctx.closePath();
    } else if (op.shape === 'ellipse') {
      ctx.ellipse((op.x + op.w / 2 - ox) * s, (op.y + op.h / 2 - oy) * s, (op.w / 2) * s, (op.h / 2) * s, 0, 0, Math.PI * 2);
    } else {
      ctx.rect((op.x - ox) * s, (op.y - oy) * s, op.w * s, op.h * s);
    }
  }

  function hitRegion(x, y) {
    const list = regions();
    for (let i = list.length - 1; i >= 0; i--) {
      const op = list[i];
      const b = bboxOf(op);
      if (op.shape !== 'lasso') {
        for (const [cx, cy, corner] of [[b.x, b.y, 'nw'], [b.x + b.w, b.y, 'ne'], [b.x, b.y + b.h, 'sw'], [b.x + b.w, b.y + b.h, 'se']]) {
          if (Math.abs(x - cx) <= HANDLE && Math.abs(y - cy) <= HANDLE) return { op, mode: 'resize', corner };
        }
      }
      const path = new Path2D();
      shapePath(path, op);
      vctx.setTransform(1, 0, 0, 1, 0, 0);
      if (vctx.isPointInPath(path, x, y)) return { op, mode: 'move' };
    }
    return null;
  }

  // ---------- drawing ----------

  // Pixelates `blur` ops onto ctx. s/ox/oy map CSS coords into ctx space.
  function drawBlurs(ctx, s, ox, oy) {
    for (const op of ops) {
      if (op.type !== 'blur') continue;
      const sx = Math.round(op.x * k);
      const sy = Math.round(op.y * k);
      const sw = Math.max(1, Math.round(op.w * k));
      const sh = Math.max(1, Math.round(op.h * k));
      const tiny = document.createElement('canvas');
      tiny.width = Math.max(1, Math.round(sw / 14));
      tiny.height = Math.max(1, Math.round(sh / 14));
      tiny.getContext('2d').drawImage(base, sx, sy, sw, sh, 0, 0, tiny.width, tiny.height);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, (op.x - ox) * s, (op.y - oy) * s, op.w * s, op.h * s);
      ctx.restore();
    }
  }

  function drawAnnotations(ctx, s, ox, oy, list = ops) {
    for (const op of list) {
      ctx.save();
      if (op.type === 'pen') {
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width * s;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const pts = op.points.map(([x, y]) => [(x - ox) * s, (y - oy) * s]);
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i][0] + pts[i + 1][0]) / 2;
          const my = (pts[i][1] + pts[i + 1][1]) / 2;
          ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last[0], last[1]);
        ctx.stroke();
      } else if (op.type === 'arrow') {
        const x1 = (op.x1 - ox) * s;
        const y1 = (op.y1 - oy) * s;
        const x2 = (op.x2 - ox) * s;
        const y2 = (op.y2 - oy) * s;
        const lw = op.width * s;
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(10 * s, lw * 4);
        ctx.strokeStyle = ctx.fillStyle = op.color;
        ctx.lineWidth = lw;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2 - Math.cos(ang) * head * 0.6, y2 - Math.sin(ang) * head * 0.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
        ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      } else if (op.type === 'highlight') {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = op.color;
        ctx.fillRect((op.x - ox) * s, (op.y - oy) * s, op.w * s, op.h * s);
      }
      ctx.restore();
    }
  }

  function render() {
    if (!dirty || !base) return;
    dirty = false;
    const dpr = devicePixelRatio;
    const W = view.width;
    const H = view.height;
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.drawImage(base, 0, 0, W, H);
    drawBlurs(vctx, dpr, 0, 0);
    drawAnnotations(vctx, dpr, 0, 0);
    if (drag?.preview && drag.preview.type !== 'region') drawAnnotations(vctx, dpr, 0, 0, [drag.preview]);

    const regs = regions();
    const pending = drag?.preview?.type === 'region' ? [drag.preview] : [];
    const all = [...regs, ...pending];

    // Shade everything outside the selected shapes.
    const shade = new Path2D();
    shade.rect(0, 0, W, H);
    for (const op of all) {
      const p = new Path2D();
      shapePath(p, op, dpr);
      shade.addPath(p);
    }
    vctx.fillStyle = all.length ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.25)';
    vctx.fill(shade, 'evenodd');

    // Outlines, numbers, size labels, resize handles.
    all.forEach((op, i) => {
      const b = bboxOf(op);
      vctx.save();
      vctx.lineWidth = 2;
      vctx.strokeStyle = ACCENT;
      vctx.setLineDash(op === drag?.preview ? [6, 4] : []);
      shapePath(vctx, op, dpr);
      vctx.stroke();
      vctx.setLineDash([]);
      // number badge, offset from the corner so the resize handle doesn't cover it
      const bx = Math.max(12, b.x - 14) * dpr;
      const by = Math.max(12, b.y - 14) * dpr;
      vctx.fillStyle = ACCENT;
      vctx.beginPath();
      vctx.arc(bx, by, 11 * dpr, 0, Math.PI * 2);
      vctx.fill();
      vctx.fillStyle = '#fff';
      vctx.font = `600 ${12 * dpr}px "Segoe UI", Arial, sans-serif`;
      vctx.textAlign = 'center';
      vctx.textBaseline = 'middle';
      vctx.fillText(String(i + 1), bx, by);
      // size label in physical pixels
      const label = `${Math.round(b.w * k)} × ${Math.round(b.h * k)}`;
      vctx.font = `${11 * dpr}px "Segoe UI", Arial, sans-serif`;
      const tw = vctx.measureText(label).width + 10 * dpr;
      const ly = (b.y + b.h) * dpr + 6 * dpr;
      vctx.fillStyle = 'rgba(29,30,33,0.92)';
      vctx.fillRect(b.x * dpr, ly, tw, 18 * dpr);
      vctx.fillStyle = '#f2f3f5';
      vctx.textAlign = 'left';
      vctx.fillText(label, b.x * dpr + 5 * dpr, ly + 9 * dpr);
      if (op.shape !== 'lasso' && op !== drag?.preview) {
        vctx.fillStyle = '#fff';
        for (const [cx, cy] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
          vctx.fillRect(cx * dpr - 4 * dpr, cy * dpr - 4 * dpr, 8 * dpr, 8 * dpr);
        }
      }
      vctx.restore();
    });
  }

  function loop() {
    try {
      if (active) render();
    } catch (err) {
      console.error('overlay render failed', err);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- pointer interaction ----------

  const pt = (e) => [Math.max(0, Math.min(innerWidth, e.clientX)), Math.max(0, Math.min(innerHeight, e.clientY))];

  view.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !base) return;
    view.setPointerCapture(e.pointerId);
    const [x, y] = pt(e);

    if (SELECTION_TOOLS.has(tool) && !e.altKey) {
      const hit = hitRegion(x, y);
      if (hit) {
        undoStack.push(JSON.stringify(ops));
        redoStack = [];
        drag = { kind: hit.mode, op: hit.op, corner: hit.corner, start: [x, y], orig: JSON.parse(JSON.stringify(hit.op)) };
        return;
      }
    }
    drag = { kind: 'draw', start: [x, y], points: [[x, y]], preview: null };
  });

  view.addEventListener('pointermove', (e) => {
    const [, y] = pt(e);
    // Keep the toolbar out of the way of where the user is working.
    if (y < 90 && !toolbar.classList.contains('bottom')) toolbar.classList.add('bottom');
    else if (y > innerHeight - 90 && toolbar.classList.contains('bottom')) toolbar.classList.remove('bottom');
    updateDrag(e);
  });

  function updateDrag(e) {
    if (!drag) return;
    const [x, y] = pt(e);

    const [sx, sy] = drag.start;
    if (drag.kind === 'move') {
      const dx = x - sx;
      const dy = y - sy;
      if (drag.op.points) drag.op.points = drag.orig.points.map(([px, py]) => [px + dx, py + dy]);
      else Object.assign(drag.op, { x: drag.orig.x + dx, y: drag.orig.y + dy });
    } else if (drag.kind === 'resize') {
      const o = drag.orig;
      const fixedX = drag.corner.includes('w') ? o.x + o.w : o.x;
      const fixedY = drag.corner.includes('n') ? o.y + o.h : o.y;
      Object.assign(drag.op, normBox(fixedX, fixedY, x, y, e.shiftKey || drag.op.square));
    } else {
      drag.points.push([x, y]);
      const square = e.shiftKey || tool === 'square';
      if (tool === 'rect' || tool === 'square') drag.preview = { type: 'region', shape: 'rect', square: tool === 'square', ...normBox(sx, sy, x, y, square) };
      else if (tool === 'ellipse') drag.preview = { type: 'region', shape: 'ellipse', ...normBox(sx, sy, x, y, e.shiftKey) };
      else if (tool === 'lasso') drag.preview = { type: 'region', shape: 'lasso', points: drag.points.slice() };
      else if (tool === 'pen') drag.preview = { type: 'pen', points: drag.points.slice(), color, width: Number(widthInput.value) };
      else if (tool === 'arrow') drag.preview = { type: 'arrow', x1: sx, y1: sy, x2: x, y2: y, color, width: Number(widthInput.value) };
      else if (tool === 'highlight') drag.preview = { type: 'highlight', color, ...normBox(sx, sy, x, y, false) };
      else if (tool === 'blur') drag.preview = { type: 'blur', ...normBox(sx, sy, x, y, false) };
      // Blur previews are drawn as committed ops so the user sees the effect live.
      if (drag.preview?.type === 'blur') {
        ops = ops.filter((o) => o !== drag.blurLive);
        drag.blurLive = drag.preview;
        ops.push(drag.blurLive);
      }
    }
    dirty = true;
  }

  view.addEventListener('pointerup', (e) => {
    if (!drag) return;
    updateDrag(e); // the release point may differ from the last (coalesced) move
    const d = drag;
    drag = null;
    if (d.kind !== 'draw') {
      dirty = true;
      return;
    }
    if (d.blurLive) ops = ops.filter((o) => o !== d.blurLive);
    const p = d.preview;
    if (!p) return;
    const b = p.type === 'arrow' ? { w: Math.abs(p.x2 - p.x1), h: Math.abs(p.y2 - p.y1) } : bboxOf(p);
    const tooSmall = p.type === 'pen' ? p.points.length < 2 : p.type === 'arrow' ? Math.hypot(b.w, b.h) < 8 : b.w < 6 || b.h < 6;
    if (tooSmall) {
      dirty = true;
      return;
    }
    if (p.shape === 'lasso' && p.points.length < 3) return;
    mutate(() => ops.push(p));
  });

  // ---------- keyboard ----------

  const KEYS = { r: 'rect', s: 'square', e: 'ellipse', l: 'lasso', p: 'pen', a: 'arrow', h: 'highlight', b: 'blur' };
  window.addEventListener('keydown', (e) => {
    if (!active) return;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') {
      e.preventDefault();
      window.overlay.cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      confirm(null);
    } else if (e.ctrlKey && (key === 'y' || (key === 'z' && e.shiftKey))) {
      redo();
    } else if (e.ctrlKey && key === 'z') {
      undo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const regs = regions();
      if (regs.length) mutate(() => { ops = ops.filter((o) => o !== regs[regs.length - 1]); });
    } else if (key === 'm' && !e.ctrlKey) {
      toggleMask();
    } else if (KEYS[key] && !e.ctrlKey && !e.altKey) {
      setTool(KEYS[key]);
    }
  });

  // ---------- export ----------

  function cropRegion(op) {
    const b = bboxOf(op);
    const x = Math.max(0, b.x);
    const y = Math.max(0, b.y);
    const w = Math.min(innerWidth, b.x + b.w) - x;
    const h = Math.min(innerHeight, b.y + b.h) - y;
    const px = Math.round(x * k);
    const py = Math.round(y * k);
    const pw = Math.max(1, Math.round(w * k));
    const ph = Math.max(1, Math.round(h * k));

    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    const ctx = c.getContext('2d');
    ctx.drawImage(base, px, py, pw, ph, 0, 0, pw, ph);
    drawBlurs(ctx, k, px / k, py / k);
    if (maskOn() && op.shape && op.shape !== 'rect') {
      const p = new Path2D();
      p.rect(0, 0, pw, ph);
      const inner = new Path2D();
      shapePath(inner, op, k, px / k, py / k);
      p.addPath(inner);
      ctx.fillStyle = '#ffffff';
      ctx.fill(p, 'evenodd');
    }
    drawAnnotations(ctx, k, px / k, py / k);
    return new Promise((resolve) => {
      c.toBlob(async (blob) => {
        resolve({
          png: new Uint8Array(await blob.arrayBuffer()),
          width: pw,
          height: ph,
          bbox: { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) },
          shape: op.shape || 'screen',
        });
      }, 'image/png');
    });
  }

  let confirming = false;
  async function confirm(action) {
    if (!base || confirming) return;
    confirming = true;
    try {
      let regs = regions();
      if (!regs.length) regs = [{ type: 'region', shape: 'rect', x: 0, y: 0, w: innerWidth, h: innerHeight }];
      const out = [];
      for (const r of regs) out.push(await cropRegion(r));
      window.overlay.confirm({ regions: out, action });
    } finally {
      confirming = false;
    }
  }

  // Read-only snapshot for the automated overlay test.
  window.__overlayState = () => JSON.parse(JSON.stringify({ tool, ops }));

  // ---------- lifecycle ----------

  window.overlay.onStart(({ width, height, bitmap }) => {
    // BGRA (Windows native) -> RGBA
    const px = new Uint8ClampedArray(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength);
    for (let i = 0; i < px.length; i += 4) {
      const b = px[i];
      px[i] = px[i + 2];
      px[i + 2] = b;
      px[i + 3] = 255;
    }
    base = document.createElement('canvas');
    base.width = width;
    base.height = height;
    base.getContext('2d').putImageData(new ImageData(px, width, height), 0, 0);
    k = width / innerWidth;
    view.width = Math.round(innerWidth * devicePixelRatio);
    view.height = Math.round(innerHeight * devicePixelRatio);
    ops = [];
    undoStack = [];
    redoStack = [];
    drag = null;
    active = true;
    dirty = true;
    toolbar.classList.remove('bottom');
    render();
    requestAnimationFrame(() => window.overlay.ready());
  });

  window.overlay.onReset(() => {
    active = false;
    base = null;
    ops = [];
    drag = null;
    vctx.clearRect(0, 0, view.width, view.height);
  });
})();
