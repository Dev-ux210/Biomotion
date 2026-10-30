import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Flow field: potential flow around an ellipsoidal body + a parametric wake.
// Car local space: nose at -x, tail at +x, wind blows toward +x, ground y = 0.
// ---------------------------------------------------------------------------
export const BODY = { a: 2.2, b: 0.52, c: 0.92, cy: 0.64 };
export const DOMAIN = { x0: -4.4, x1: 5.0 };
export const F = { vx: 0, vy: 0, vz: 0, sp: 1, e: 0 };

export function sampleField(x, y, z, c, t) {
  const { a, b, c: cc, cy } = BODY;
  let px = x / a, py = (y - cy) / b, pz = z / cc;
  let r2 = px * px + py * py + pz * pz;
  if (r2 < 1) { const k = 1 / Math.sqrt(Math.max(r2, 1e-4)); px *= k; py *= k; pz *= k; r2 = 1; }
  const r = Math.sqrt(r2), r3 = r2 * r, r5 = r3 * r2;
  const k1 = 1.5 * px / r5;
  let vx = 1 + k1 * px - 0.5 / r3;
  let vy = k1 * py * (b / a);
  let vz = k1 * pz * (cc / a);

  if (y < 0.25) { vy *= y <= 0 ? 0 : y / 0.25; }
  const bl = 1 - c.bl * Math.exp(-(r - 1) * 7);
  vx *= bl; vy *= bl; vz *= bl;

  let e = 0;
  const xi = x - 1.2;
  if (xi > 0) {
    const grow = 1 + 0.22 * xi;
    const hy = (y - 0.6) / (c.wh * grow), wz = z / (c.ww * grow);
    const q = Math.min(xi / 0.9, 1), ramp = q * q * (3 - 2 * q);
    e = Math.exp(-(hy * hy + wz * wz) - xi / c.lw) * ramp * c.ws;
    vx *= 1 - 0.55 * e;
    if (xi < c.rec) vx -= 0.8 * e * (1 - xi / c.rec);
    vy -= 0.28 * e * Math.exp(-xi * 0.9);
    const w = c.omega * t;
    vy += c.amp * e * (Math.sin(c.k * xi - w + 1.7 * z) + 0.5 * Math.sin(2.3 * c.k * xi - 1.6 * w + 3.1 * y));
    vz += c.amp * e * (Math.cos(0.8 * c.k * xi - 0.9 * w + 2 * y) + 0.5 * Math.cos(2.1 * c.k * xi - w + 2.7 * z));
  }
  vy += 0.02 * c.turb * Math.sin(2.1 * x - 1.3 * t + 3 * z);
  vz += 0.02 * c.turb * Math.cos(1.7 * x - t + 2 * y);
  F.vx = vx; F.vy = vy; F.vz = vz; F.e = e;
  F.sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
  F.r = r;
}

// ---------------------------------------------------------------------------
// Shared shaders
// ---------------------------------------------------------------------------
const CMAP = /* glsl */`
vec3 cmap(float s){
  s = clamp(s, 0.0, 1.7);
  vec3 c0 = vec3(0.95,0.12,0.08), c1 = vec3(1.0,0.50,0.18), c2 = vec3(0.10,0.80,0.95), c3 = vec3(0.75,1.0,0.30), c4 = vec3(1.0,1.0,0.90);
  vec3 c = mix(c0,c1,smoothstep(0.0,0.45,s));
  c = mix(c,c2,smoothstep(0.45,0.85,s));
  c = mix(c,c3,smoothstep(0.85,1.2,s));
  return mix(c,c4,smoothstep(1.2,1.7,s));
}`;

export const shared = {
  uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uFlow: { value: 0.25 },
  uGlobal: { value: 0 }, uPx: { value: 500 }, uPR: { value: 1 },
};

class Ribbons {
  constructor(maxSeg, mode, width) {
    this.max = maxSeg;
    this.pos = new Float32Array(maxSeg * 6);
    this.meta = new Float32Array(maxSeg * 4);
    this.ids = new Float32Array(maxSeg);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.ib = new THREE.InstancedInterleavedBuffer(this.pos, 6, 1); this.ib.setUsage(THREE.DynamicDrawUsage);
    this.mb = new THREE.InstancedBufferAttribute(this.meta, 4); this.mb.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iStart', new THREE.InterleavedBufferAttribute(this.ib, 3, 0));
    g.setAttribute('iEnd', new THREE.InterleavedBufferAttribute(this.ib, 3, 3));
    g.setAttribute('iMeta', this.mb);
    g.setAttribute('iId', new THREE.InstancedBufferAttribute(this.ids, 1));
    g.instanceCount = maxSeg;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...shared, uMode: { value: mode }, uWidth: { value: width }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */`
        attribute vec3 iStart; attribute vec3 iEnd; attribute vec4 iMeta; attribute float iId;
        uniform vec2 uRes; uniform float uWidth; uniform float uPR;
        varying float vT; varying float vSp; varying float vId; varying float vEdge;
        void main(){
          vec4 cs = projectionMatrix*modelViewMatrix*vec4(iStart,1.0);
          vec4 ce = projectionMatrix*modelViewMatrix*vec4(iEnd,1.0);
          vec2 ss = cs.xy/cs.w*uRes*0.5; vec2 se = ce.xy/ce.w*uRes*0.5;
          vec2 d = se-ss; float len = length(d);
          if(len < 0.02 && distance(iStart,iEnd) < 1e-5){ gl_Position = vec4(2.0,2.0,2.0,1.0); return; }
          d = len > 1e-4 ? d/len : vec2(1.0,0.0);
          vec2 n = vec2(-d.y,d.x);
          float along = position.x;
          vec4 c = mix(cs,ce,along);
          vec2 off = n*position.y*uWidth*uPR*0.5;
          c.xy += off/(uRes*0.5)*c.w;
          gl_Position = c;
          vT = mix(iMeta.x,iMeta.y,along); vSp = mix(iMeta.z,iMeta.w,along); vId = iId; vEdge = position.y;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform float uFlow; uniform float uMode; uniform float uGlobal; uniform float uOpacity;
        varying float vT; varying float vSp; varying float vId; varying float vEdge;
        ${CMAP}
        void main(){
          vec3 col = cmap(vSp);
          float edge = 1.0 - smoothstep(0.35,1.0,abs(vEdge));
          float a;
          if(uMode < 0.5){
            float pulse = pow(fract(vT*2.4 - uTime*uFlow + vId), 6.0);
            float fade = smoothstep(0.0,0.07,vT)*(1.0-smoothstep(0.86,1.0,vT));
            a = (0.055 + 0.5*pulse)*fade*edge;
            col *= 0.9 + pulse*1.0;
          } else {
            a = pow(vT,1.6)*edge*0.7;
            col *= 0.8 + vT*0.8;
          }
          gl_FragColor = vec4(col, a*uGlobal*uOpacity);
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }
  flush() { this.ib.needsUpdate = true; this.mb.needsUpdate = true; }
}

function pointsMaterial(kind) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...shared, uKind: { value: kind } },
    vertexShader: /* glsl */`
      attribute float aSize; attribute float aAlpha; attribute float aSpeed;
      uniform float uPx; uniform float uPR; uniform float uKind;
      varying float vA; varying float vS;
      void main(){
        vec4 mv = modelViewMatrix*vec4(position,1.0);
        gl_Position = projectionMatrix*mv;
        gl_PointSize = uKind < 0.5 ? max(aSize*uPx/(-mv.z), 1.0) : (1.6 + aSize*0.8)*uPR;
        vA = aAlpha; vS = aSpeed;
      }`,
    fragmentShader: /* glsl */`
      uniform float uKind; uniform float uGlobal;
      varying float vA; varying float vS;
      ${CMAP}
      void main(){
        vec2 p = gl_PointCoord-0.5; float r = length(p)*2.0;
        if(r>1.0) discard;
        float a = uKind < 0.5 ? exp(-r*r*3.2)*(1.0-r) : (1.0-r*r);
        vec3 col = cmap(vS + (uKind<0.5 ? 0.15 : 0.0)) * (uKind<0.5 ? 0.8 : 1.3);
        gl_FragColor = vec4(col, a*vA*uGlobal);
      }`,
  });
}

const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

export class FlowSystem {
  constructor(bio, mobile) {
    this.bio = bio;
    this.group = new THREE.Group();
    this.STEPS = mobile ? 90 : 120;
    const NY = mobile ? 6 : 8, NZ = mobile ? 9 : 13;
    this.nLines = NY * NZ;
    this.seeds = [];
    for (let j = 0; j < NY; j += 1) for (let i = 0; i < NZ; i += 1) {
      const u = (j + 0.5 + (hash(j * 17 + i) - 0.5) * 0.8) / NY, v = (i + 0.5 + (hash(i * 31 + j * 7) - 0.5) * 0.8) / NZ;
      this.seeds.push({ y: 0.05 + Math.pow(u, 1.25) * 1.75, z: (v - 0.5) * 3.5, id: hash(j * 97 + i * 13) });
    }
    this.lines = new Ribbons(this.nLines * this.STEPS, 0, mobile ? 1.5 : 1.7);
    for (let s = 0; s < this.nLines; s += 1) for (let i = 0; i < this.STEPS; i += 1) this.lines.ids[s * this.STEPS + i] = this.seeds[s].id;
    this.group.add(this.lines.mesh);
    this._pts = new Float32Array((this.STEPS + 1) * 3); this._spd = new Float32Array(this.STEPS + 1);

    // tracer particles with trails
    this.K = 12; this.N = mobile ? 600 : 1400;
    this.pp = new Float32Array(this.N * 3); this.psp = new Float32Array(this.N);
    this.hist = new Float32Array(this.N * this.K * 3);
    this.trails = new Ribbons(this.N * (this.K - 1), 1, mobile ? 1.8 : 2.2);
    for (let i = 0; i < this.N; i += 1) { this.spawn(i, true); }
    this.group.add(this.trails.mesh);
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(this.pp, 3).setUsage(THREE.DynamicDrawUsage));
    hg.setAttribute('aSpeed', new THREE.BufferAttribute(this.psp, 1).setUsage(THREE.DynamicDrawUsage));
    hg.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(this.N).fill(0.9), 1));
    hg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(this.N).fill(1), 1));
    this.heads = new THREE.Points(hg, pointsMaterial(1)); this.heads.frustumCulled = false; this.heads.renderOrder = 6;
    this.group.add(this.heads);
    this.tick = 0;

    // wake smoke
    this.M = mobile ? 150 : 360;
    this.sp3 = new Float32Array(this.M * 3); this.sAge = new Float32Array(this.M); this.sRate = new Float32Array(this.M);
    this.sSize = new Float32Array(this.M); this.sAlpha = new Float32Array(this.M); this.sSpd = new Float32Array(this.M);
    for (let i = 0; i < this.M; i += 1) { this.spawnSmoke(i); this.sAge[i] = Math.random(); }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sp3, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('aSize', new THREE.BufferAttribute(this.sSize, 1).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('aAlpha', new THREE.BufferAttribute(this.sAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('aSpeed', new THREE.BufferAttribute(this.sSpd, 1).setUsage(THREE.DynamicDrawUsage));
    this.smoke = new THREE.Points(sg, pointsMaterial(0)); this.smoke.frustumCulled = false; this.smoke.renderOrder = 4;
    this.group.add(this.smoke);
  }

  spawn(i, anywhere) {
    const x = anywhere ? DOMAIN.x0 + Math.random() * (DOMAIN.x1 - DOMAIN.x0) : DOMAIN.x0 + Math.random() * 0.3;
    const y = 0.04 + Math.pow(Math.random(), 1.3) * 1.9, z = (Math.random() - 0.5) * 3.4;
    this.pp[i * 3] = x; this.pp[i * 3 + 1] = y; this.pp[i * 3 + 2] = z; this.psp[i] = 1;
    const b = i * this.K * 3;
    for (let k = 0; k < this.K; k += 1) { this.hist[b + k * 3] = x; this.hist[b + k * 3 + 1] = y; this.hist[b + k * 3 + 2] = z; }
  }

  spawnSmoke(i) {
    this.sp3[i * 3] = 0.9 + Math.random() * 1.2; this.sp3[i * 3 + 1] = 0.3 + Math.random() * 0.75; this.sp3[i * 3 + 2] = (Math.random() - 0.5) * 1.3;
    this.sAge[i] = 0; this.sRate[i] = 1 / (2.4 + Math.random() * 2.2);
  }

  setLayers(l) { this.lines.mesh.visible = l.streams; this.trails.mesh.visible = l.particles; this.heads.visible = l.particles; this.smoke.visible = l.smoke; }

  update(dt, c, t, U) {
    const { a, b, c: cc, cy } = BODY;
    // streamlines
    const S = this.STEPS, ds = (DOMAIN.x1 - DOMAIN.x0) / S * 0.97;
    const lp = this.lines.pos, lm = this.lines.meta, P = this._pts, SP = this._spd;
    for (let s = 0; s < this.nLines; s += 1) {
      const sd = this.seeds[s];
      let x = DOMAIN.x0, y = sd.y, z = sd.z;
      P[0] = x; P[1] = y; P[2] = z; SP[0] = 1;
      for (let i = 1; i <= S; i += 1) {
        sampleField(x, y, z, c, t);
        let m = F.sp || 1, dx = F.vx / m, dy = F.vy / m, dz = F.vz / m;
        if (dx < 0.12) { dx = 0.12; const n = Math.hypot(dx, dy, dz); dx /= n; dy /= n; dz /= n; }
        sampleField(x + dx * ds * 0.5, y + dy * ds * 0.5, z + dz * ds * 0.5, c, t);
        m = F.sp || 1; dx = F.vx / m; dy = F.vy / m; dz = F.vz / m;
        if (dx < 0.12) { dx = 0.12; const n = Math.hypot(dx, dy, dz); dx /= n; dy /= n; dz /= n; }
        SP[i] = F.sp;
        x += dx * ds; y = Math.max(y + dy * ds, 0.02); z += dz * ds;
        const r2 = (x / a) * (x / a) + ((y - cy) / b) * ((y - cy) / b) + (z / cc) * (z / cc);
        if (r2 < 1.02) { const k = 1.03 / Math.sqrt(r2); const ny = cy + (y - cy) * k; x *= k; z *= k; y = ny; }
        P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
      }
      const base = s * S;
      for (let i = 0; i < S; i += 1) {
        const o = (base + i) * 6, mo = (base + i) * 4;
        lp[o] = P[i * 3]; lp[o + 1] = P[i * 3 + 1]; lp[o + 2] = P[i * 3 + 2];
        lp[o + 3] = P[i * 3 + 3]; lp[o + 4] = P[i * 3 + 4]; lp[o + 5] = P[i * 3 + 5];
        lm[mo] = i / S; lm[mo + 1] = (i + 1) / S; lm[mo + 2] = SP[i]; lm[mo + 3] = SP[i + 1];
      }
    }
    this.lines.flush();

    // particles
    const K = this.K, pp = this.pp, hist = this.hist;
    this.tick += dt;
    const doTick = this.tick > 0.03; if (doTick) this.tick = 0;
    const tp = this.trails.pos, tm = this.trails.meta, tid = this.trails.ids;
    for (let i = 0; i < this.N; i += 1) {
      let x = pp[i * 3], y = pp[i * 3 + 1], z = pp[i * 3 + 2];
      sampleField(x, y, z, c, t);
      x += F.vx * U * dt; y += F.vy * U * dt; z += F.vz * U * dt;
      if (F.e > 0.02) { const d = F.e * c.turb * 0.22 * U * dt; x += (Math.random() - 0.5) * d; y += (Math.random() - 0.5) * d; z += (Math.random() - 0.5) * d; }
      const r2 = (x / a) * (x / a) + ((y - cy) / b) * ((y - cy) / b) + (z / cc) * (z / cc);
      if (r2 < 1.02) { const k = 1.03 / Math.sqrt(r2); const ny = cy + (y - cy) * k; x *= k; z *= k; y = ny; }
      if (y < 0.02) y = 0.02;
      this.psp[i] = F.sp;
      if (x > DOMAIN.x1 || Math.abs(z) > 2.2 || y > 2.5) { this.spawn(i, false); continue; }
      pp[i * 3] = x; pp[i * 3 + 1] = y; pp[i * 3 + 2] = z;
      const hb = i * K * 3;
      if (doTick) hist.copyWithin(hb + 3, hb, hb + (K - 1) * 3);
      hist[hb] = x; hist[hb + 1] = y; hist[hb + 2] = z;
    }
    for (let i = 0; i < this.N; i += 1) {
      const hb = i * K * 3, sp = this.psp[i];
      for (let j = 0; j < K - 1; j += 1) {
        const si = i * (K - 1) + j, o = si * 6, mo = si * 4, h0 = hb + (j + 1) * 3, h1 = hb + j * 3;
        tp[o] = hist[h0]; tp[o + 1] = hist[h0 + 1]; tp[o + 2] = hist[h0 + 2];
        tp[o + 3] = hist[h1]; tp[o + 4] = hist[h1 + 1]; tp[o + 5] = hist[h1 + 2];
        tm[mo] = 1 - (j + 1) / (K - 1); tm[mo + 1] = 1 - j / (K - 1); tm[mo + 2] = sp; tm[mo + 3] = sp;
        tid[si] = 0;
      }
    }
    this.trails.flush();
    this.heads.geometry.attributes.position.needsUpdate = true;
    this.heads.geometry.attributes.aSpeed.needsUpdate = true;

    // smoke
    const ws = c.ws, base = 0.3 + 0.55 * ws;
    for (let i = 0; i < this.M; i += 1) {
      let x = this.sp3[i * 3], y = this.sp3[i * 3 + 1], z = this.sp3[i * 3 + 2];
      sampleField(x, y, z, c, t);
      x += F.vx * U * dt * 0.7; y += F.vy * U * dt * 0.7; z += F.vz * U * dt * 0.7;
      this.sp3[i * 3] = x; this.sp3[i * 3 + 1] = Math.max(y, 0.05); this.sp3[i * 3 + 2] = z;
      this.sAge[i] += this.sRate[i] * dt * (0.5 + U * 0.15);
      const age = this.sAge[i];
      if (age >= 1 || x > DOMAIN.x1) { this.spawnSmoke(i); continue; }
      this.sSize[i] = base * (0.7 + age * 2.4);
      this.sAlpha[i] = Math.pow(1 - age, 1.6) * Math.min(age * 8, 1) * 0.045 * (0.25 + ws) * (0.6 + 0.4 * c.turb);
      this.sSpd[i] = F.sp;
    }
    const g = this.smoke.geometry.attributes;
    g.position.needsUpdate = true; g.aSize.needsUpdate = true; g.aAlpha.needsUpdate = true; g.aSpeed.needsUpdate = true;
  }
}
