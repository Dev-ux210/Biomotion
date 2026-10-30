// Hero background: a live 2D flow field. Air streams left → right around an
// invisible streamlined body, so the flow itself draws the silhouette.
export function initHeroFlow(canvas) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = matchMedia('(max-width: 700px)').matches;
  const N = mobile ? 420 : 1250;
  const mouse = { x: -9999, y: -9999, active: false };
  let W = 0, H = 0, dpr = 1, running = false, t = 0, last = 0;
  let body = { x: 0, y: 0, r: 100, sq: 2.1 };
  const P = [];

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (P.length && (W < 2 || H < 2)) return;
    body = { x: W * (mobile ? 0.62 : 0.66), y: H * 0.52, r: Math.min(W, H * 1.6) * (mobile ? 0.17 : 0.15), sq: 2.1 };
  }

  function spawn(p, anywhere) {
    p.x = anywhere ? Math.random() * W : -20 - Math.random() * 60;
    p.y = Math.random() * H;
    p.px = p.x; p.py = p.y; p.life = 0; p.max = 220 + Math.random() * 260; p.s = 0.6 + Math.random() * 0.8;
  }
  function seed() { P.length = 0; for (let i = 0; i < N; i += 1) { const p = {}; spawn(p, true); p.life = Math.random() * p.max * 0.8; P.push(p); } }

  const out = { vx: 1, vy: 0, sp: 1 };
  function field(x, y) {
    // potential flow around a squashed cylinder
    let dx = x - body.x, dy = (y - body.y) * body.sq;
    const R2 = body.r * body.r;
    let r2 = dx * dx + dy * dy;
    if (r2 < R2) { const k = Math.sqrt(R2 / Math.max(r2, 1)); dx *= k; dy *= k; r2 = R2; }
    const r4 = r2 * r2;
    let vx = 1 + R2 * (dy * dy - dx * dx) / r4;
    let vy = (-2 * R2 * dx * dy / r4) / body.sq;
    // ambient curl-ish wobble
    const ang = Math.sin(x * 0.006 + t * 0.35) * 0.55 + Math.cos(y * 0.008 - t * 0.25) * 0.55;
    vx += Math.cos(ang) * 0.12; vy += Math.sin(ang) * 0.28;
    // turbulent wake behind the body
    const wx = x - (body.x + body.r * 0.7);
    if (wx > 0) {
      const env = Math.exp(-Math.pow((y - body.y) / (body.r * 0.85 + wx * 0.09), 2)) * Math.exp(-wx / (body.r * 4.2)) * Math.min(wx / 40, 1);
      vx *= 1 - 0.5 * env;
      vy += env * 1.15 * Math.sin(wx * 0.045 - t * 3.2 + y * 0.02);
    }
    // pointer: repel + swirl
    if (mouse.active) {
      const mx = x - mouse.x, my = y - mouse.y, d2 = mx * mx + my * my, rad = 190;
      if (d2 < rad * rad) {
        const f = 1 - Math.sqrt(d2) / rad, d = Math.sqrt(d2) + 1;
        vx += (mx / d) * f * 1.5 - (my / d) * f * 1.1;
        vy += (my / d) * f * 1.5 + (mx / d) * f * 1.1;
      }
    }
    out.vx = vx; out.vy = vy; out.sp = Math.hypot(vx, vy);
  }

  function color(sp, a) {
    // slow → coral, free stream → cyan, fast → acid
    let r, g, b;
    if (sp < 0.7) { const k = Math.max(sp - 0.2, 0) / 0.5; r = 255 + (60 - 255) * k; g = 128 + (215 - 128) * k; b = 97 + (205 - 97) * k; }
    else { const k = Math.min((sp - 0.7) / 0.7, 1); r = 60 + (210 - 60) * k; g = 215 + (255 - 215) * k; b = 205 + (110 - 205) * k; }
    return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
  }

  let raf = 0, tick = 0;
  function step(dt, fade) {
    t += dt;
    if (fade) {
      // a periodic stronger fade clears the faint residue that 8-bit alpha rounding leaves behind
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0,0,0,${(tick += 1) % 45 === 0 ? 0.35 : 0.085})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1.15; ctx.lineCap = 'round';
    const speed = 150 * dt;
    for (let i = 0; i < N; i += 1) {
      const p = P[i];
      field(p.x, p.y);
      p.px = p.x; p.py = p.y;
      p.x += out.vx * speed * p.s * 0.55; p.y += out.vy * speed * p.s * 0.55; p.life += 1;
      const fadeIn = Math.min(p.life / 25, 1), fadeOut = Math.min((p.max - p.life) / 40, 1);
      const a = Math.max(0, Math.min(fadeIn, fadeOut)) * 0.55;
      ctx.strokeStyle = color(out.sp, a);
      ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.x, p.y); ctx.stroke();
      if (p.x > W + 30 || p.y < -30 || p.y > H + 30 || p.life > p.max) spawn(p, false);
    }
  }
  function frame(now) {
    if (!running) { raf = 0; return; }
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    step(dt, true);
    raf = requestAnimationFrame(frame);
  }

  function start() { if (running) return; running = true; last = performance.now(); if (!raf) raf = requestAnimationFrame(frame); }
  function stop() { running = false; }

  resize();
  seed();
  window.addEventListener('resize', resize);
  const host = canvas.parentElement;
  host.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.active = true; });
  host.addEventListener('pointerleave', () => { mouse.active = false; });
  if (reduce) { for (let k = 0; k < 160; k += 1) step(1 / 60, false); }
  new IntersectionObserver((entries) => entries.forEach((en) => (en.isIntersecting && !reduce ? start() : stop())), { threshold: 0 }).observe(canvas);
}
