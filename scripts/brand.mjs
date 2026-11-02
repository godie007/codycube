// Genera los SVG de marca a partir de un modelo geométrico del rack, proyectado en perspectiva real.
//   src/renderer/src/assets/cluster-logo.svg   logo animado con fondo transparente
//   src/renderer/src/assets/cluster-hero.svg   imagen panorámica animada del clúster en su sala
//   resources/icon.svg                         icono de la app, un fotograma fijo sobre fondo redondeado
// Uso: node scripts/brand.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const n = (value) => +value.toFixed(2)

/** Aleatorio con semilla: regenerar da exactamente los mismos archivos */
function random(seed) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function projector({ yaw, pitch, dist, scale, cx, cy }) {
  const [cy1, sy1, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)]
  return ([x, y, z]) => {
    const x1 = x * cy1 + z * sy1
    const z1 = -x * sy1 + z * cy1
    const y1 = y * cp - z1 * sp
    const z2 = y * sp + z1 * cp
    const k = dist / (dist - z2)
    return [cx + x1 * k * scale, cy - y1 * k * scale]
  }
}

const poly = (points, fill, extra = '') => `<polygon points="${points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="${fill}"${extra ? ` ${extra}` : ''}/>`

/** Curva suave que pasa por todos los puntos (Catmull-Rom convertida a Bézier) */
function smoothPath(points) {
  let d = `M${n(points[0][0])} ${n(points[0][1])}`
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [points[Math.max(0, i - 1)], points[i], points[i + 1], points[Math.min(points.length - 1, i + 2)]]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(p2[0])} ${n(p2[1])}`
  }
  return d
}

const DEFS = `
<linearGradient id="side" x1="0" x2="1"><stop offset="0" stop-color="#56606c"/><stop offset=".3" stop-color="#8a95a3"/><stop offset=".62" stop-color="#47505b"/><stop offset="1" stop-color="#20252c"/></linearGradient>
<linearGradient id="top" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#a7b1bd"/><stop offset=".5" stop-color="#6b7581"/><stop offset="1" stop-color="#39414b"/></linearGradient>
<linearGradient id="face" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a414a"/><stop offset=".12" stop-color="#2a2f37"/><stop offset=".85" stop-color="#1a1e24"/><stop offset="1" stop-color="#0e1115"/></linearGradient>
<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".45" stop-color="#fff" stop-opacity=".03"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="bay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#20242b"/><stop offset="1" stop-color="#0a0c10"/></linearGradient>
<linearGradient id="handle" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1f5f9"/><stop offset=".5" stop-color="#8590a0"/><stop offset="1" stop-color="#cfd6de"/></linearGradient>
<linearGradient id="post" x1="0" x2="1"><stop offset="0" stop-color="#14171c"/><stop offset=".45" stop-color="#454d58"/><stop offset="1" stop-color="#0d0f13"/></linearGradient>
<linearGradient id="plate" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b424c"/><stop offset=".5" stop-color="#2a2f37"/><stop offset="1" stop-color="#14171c"/></linearGradient>
<linearGradient id="grille" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#59626e"/><stop offset="1" stop-color="#2c323a"/></linearGradient>
<radialGradient id="glow-teal"><stop offset="0" stop-color="#d8fff8"/><stop offset=".2" stop-color="#7ff5e0" stop-opacity=".75"/><stop offset=".55" stop-color="#4fc3b0" stop-opacity=".16"/><stop offset="1" stop-color="#4fc3b0" stop-opacity="0"/></radialGradient>
<radialGradient id="glow-amber"><stop offset="0" stop-color="#fff2d6"/><stop offset=".22" stop-color="#ffb648" stop-opacity=".75"/><stop offset="1" stop-color="#ffb648" stop-opacity="0"/></radialGradient>
<radialGradient id="shadow"><stop offset="0" stop-color="#000" stop-opacity=".62"/><stop offset=".65" stop-color="#000" stop-opacity=".22"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
<radialGradient id="floor-glow"><stop offset="0" stop-color="#4fc3b0" stop-opacity=".34"/><stop offset="1" stop-color="#4fc3b0" stop-opacity="0"/></radialGradient>`

const STYLE = (animated) => `
.bit{offset-rotate:0deg;animation:travel 4s linear infinite}
@keyframes travel{0%{offset-distance:0%;opacity:0}9%{opacity:1}91%{opacity:1}100%{offset-distance:100%;opacity:0}}
.a{animation:a 1.3s steps(1) infinite}.b{animation:b 2.1s steps(1) infinite}.c{animation:c .9s steps(1) infinite}.s{animation:s 3.2s ease-in-out infinite}
@keyframes a{0%{opacity:1}21%{opacity:.08}29%{opacity:1}57%{opacity:.08}63%{opacity:1}84%{opacity:.08}}
@keyframes b{0%{opacity:1}44%{opacity:.08}51%{opacity:1}72%{opacity:.08}91%{opacity:1}}
@keyframes c{0%{opacity:.08}17%{opacity:1}39%{opacity:.08}52%{opacity:1}78%{opacity:.08}}
@keyframes s{0%,100%{opacity:1}50%{opacity:.25}}
.p{animation:p 3.4s ease-in-out infinite}@keyframes p{0%,100%{opacity:.55}50%{opacity:1}}
text{font:700 1px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-anchor:middle;dominant-baseline:central;fill:#eafffb}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
${animated ? '' : '*{animation:none!important}'}`

/** El rack completo. Se dibuja de atrás adelante: el orden es lo que da el volumen */
function rack(P, o) {
  const rand = random(o.seed)
  const [W, H, D, GAP, S] = [3.1, 0.6, 2.3, 0.13, 3]
  const slot = (i) => (i - (S - 1) / 2) * (H + GAP)
  const parts = []
  const box = (x0, x1, y0, y1, z0, z1, fills) => {
    const v = (x, y, z) => P([x, y, z])
    if (fills.right) parts.push(poly([v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)], fills.right))
    if (fills.top) parts.push(poly([v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), v(x0, y1, z0)], fills.top))
    if (fills.front) parts.push(poly([v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)], fills.front))
  }
  const totalH = S * (H + GAP)
  const pw = 0.2
  const postX = (W + pw) / 2
  const plateY = totalH / 2 + 0.2

  // Fondo: placa inferior y soportes traseros
  box(-W / 2 - pw, W / 2 + pw, -plateY - 0.12, -plateY, -D / 2 - 0.1, D / 2 + 0.1, { top: 'url(#plate)', right: '#14171c', front: 'url(#post)' })
  for (const x of [-postX, postX]) box(x - pw / 2, x + pw / 2, -plateY, plateY, -D / 2 - pw / 2, -D / 2 + pw / 2, { right: 'url(#post)', front: 'url(#post)' })

  const zf = D / 2
  for (let s = 0; s < S; s++) {
    const y = slot(s)
    const [y0, y1] = [y - H / 2, y + H / 2]
    box(-W / 2, W / 2, y0, y1, -D / 2, zf, { right: 'url(#side)', top: 'url(#top)' })
    // Vetas del metal cepillado
    for (let i = 0; i < o.brushed; i++) {
      const yy = y0 + rand() * H
      const z0 = -D / 2 + rand() * D * 0.7
      const [a, b] = [P([W / 2, yy, z0]), P([W / 2, yy, Math.min(zf, z0 + 0.3 + rand() * 0.9)])]
      parts.push(`<path d="M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}" stroke="${rand() > 0.5 ? '#fff' : '#000'}" stroke-opacity="${n(0.05 + rand() * 0.09)}" stroke-width="${o.line}"/>`)
    }
    // Ranuras de ventilación del lateral
    for (let i = 0; i < o.sideVents; i++) {
      const z = -D / 2 + 0.28 + i * 0.13
      const [a, b] = [P([W / 2, y0 + 0.14, z]), P([W / 2, y1 - 0.14, z])]
      parts.push(`<path d="M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}" stroke="#0a0c0f" stroke-opacity=".75" stroke-width="${o.line * 2.2}" stroke-linecap="round"/>`)
    }
    const fp = (x, yy, dz = 0) => P([x, yy, zf + dz])
    const quad = (x0, x1, a, b, fill, dz = 0, extra = '') => poly([fp(x0, a, dz), fp(x1, a, dz), fp(x1, b, dz), fp(x0, b, dz)], fill, extra)
    parts.push(quad(-W / 2, W / 2, y0, y1, 'url(#face)'))
    parts.push(quad(-W / 2, W / 2, y1 - 0.025, y1, '#7c8693'))
    // Tira de marca, con su resplandor
    parts.push(quad(-W / 2 + 0.07, -W / 2 + 0.115, y0 + 0.09, y1 - 0.09, '#7ff5e0', 0, 'class="p"'))
    // Bahías de disco
    const grilleWidth = o.grilleCols ? 0.82 : 0.5
    const baysLeft = -W / 2 + 0.17
    const bw = (W - 0.17 - grilleWidth - 0.12) / o.bays
    const leds = []
    for (let b = 0; b < o.bays; b++) {
      const [x0, x1] = [baysLeft + b * bw + 0.012, baysLeft + (b + 1) * bw - 0.012]
      parts.push(quad(x0, x1, y0 + 0.055, y1 - 0.055, 'url(#bay)', 0.004))
      parts.push(quad(x0 + 0.03, x1 - 0.03, y0 + 0.1, y0 + 0.155, 'url(#handle)', 0.012))
      const ly = y1 - 0.13
      leds.push({ at: fp(x0 + (x1 - x0) * 0.28, ly, 0.012), amber: false, cls: 'abc'[Math.floor(rand() * 3)], delay: rand() * 2 })
      leds.push({ at: fp(x0 + (x1 - x0) * 0.72, ly, 0.012), amber: b === (s * 2 + 1) % o.bays, cls: 's', delay: rand() * 3 })
    }
    // Rejilla
    const gx0 = W / 2 - grilleWidth - 0.05
    const gx1 = W / 2 - 0.05
    parts.push(quad(gx0, gx1, y0 + 0.07, y1 - 0.07, o.grilleCols ? 'url(#grille)' : '#0a0c10', 0.004))
    for (let r = 0; r < o.grilleRows; r++) {
      for (let c = 0; c < o.grilleCols; c++) {
        const hx = gx0 + 0.035 + (c + (r % 2) * 0.5) * ((grilleWidth - 0.07) / o.grilleCols)
        const hy = y0 + 0.11 + (r * (H - 0.22)) / Math.max(1, o.grilleRows - 1)
        const hex = Array.from({ length: 6 }, (_, a) => fp(hx + 0.017 * Math.cos((a * Math.PI) / 3 + Math.PI / 6), hy + 0.017 * Math.sin((a * Math.PI) / 3 + Math.PI / 6), 0.005))
        parts.push(poly(hex, '#05070a'))
      }
    }
    parts.push(quad(-W / 2, W / 2, y0, y1, 'url(#sheen)', 0.014))
    for (const led of leds) {
      const [x, yy] = led.at
      const glow = led.amber ? 'amber' : 'teal'
      parts.push(`<circle class="${led.cls}" style="animation-delay:-${n(led.delay)}s" cx="${n(x)}" cy="${n(yy)}" r="${o.led}" fill="url(#glow-${glow})"/>`)
    }
  }

  // Delante: soportes frontales y placa superior
  for (const x of [-postX, postX]) {
    box(x - pw / 2, x + pw / 2, -plateY, plateY, zf - pw / 2, zf + pw / 2, { right: 'url(#post)', front: 'url(#post)' })
    if (o.screws) {
      for (let i = 0; i < 7; i++) {
        const [cx, cy] = P([x, -plateY + 0.17 + (i * (2 * plateY - 0.34)) / 6, zf + pw / 2])
        parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${o.screws}" fill="#8c95a1"/><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(o.screws * 0.45)}" fill="#111419"/>`)
      }
    }
  }
  box(-W / 2 - pw, W / 2 + pw, plateY, plateY + 0.12, -D / 2 - 0.1, D / 2 + 0.1, { top: 'url(#top)', right: 'url(#side)', front: 'url(#post)' })

  return { body: parts.join(''), slot, zf, W, plateY }
}

/** Fibras de vidrio y los bits que viajan por ellas */
function streams(P, r, o) {
  const rand = random(o.seed + 7)
  const [zf, ex] = [r.zf + 0.04, r.W / 2 - 0.1]
  const s = r.slot
  const routes = [
    [[ex, s(2), zf], [ex + 0.42, s(2) - 0.1, zf + 0.3], [ex + 0.42, s(1) + 0.1, zf + 0.3], [ex, s(1), zf]],
    [[ex, s(1), zf], [ex + 0.42, s(1) - 0.1, zf + 0.3], [ex + 0.42, s(0) + 0.1, zf + 0.3], [ex, s(0), zf]],
    [[-ex, s(0), zf], [-ex - 0.45, s(0) + 0.15, zf + 0.34], [-ex - 0.45, s(2) - 0.15, zf + 0.34], [-ex, s(2), zf]],
    ...o.outer
  ].map((route) => smoothPath(route.map(P)))
  const out = []
  for (const d of routes) {
    out.push(`<path d="${d}" fill="none" stroke="#071412" stroke-width="${o.fiber * 1.9}" stroke-linecap="round"/>`)
    out.push(`<path class="p" d="${d}" fill="none" stroke="#4fc3b0" stroke-width="${o.fiber}" stroke-linecap="round"/>`)
    out.push(`<path d="${d}" fill="none" stroke="#d8fff8" stroke-opacity=".6" stroke-width="${n(o.fiber * 0.28)}" stroke-linecap="round"/>`)
  }
  const c = o.cube
  const cube = poly([[0, -c], [c * 0.87, -c * 0.5], [0, 0], [-c * 0.87, -c * 0.5]], '#eafffb') + poly([[-c * 0.87, -c * 0.5], [0, 0], [0, c], [-c * 0.87, c * 0.5]], '#7ff5e0') + poly([[c * 0.87, -c * 0.5], [0, 0], [0, c], [c * 0.87, c * 0.5]], '#35a896')
  routes.forEach((d, stream) => {
    const duration = o.duration + (stream % 3) * 0.8
    for (let i = 0; i < o.bits; i++) {
      const phase = (i + rand() * 0.3) / o.bits
      const digit = rand() > 0.5 ? '1' : '0'
      const label = o.digit ? `<text x="${n(c * 1.1)}" y="${n(-c * 1.9)}" style="font-size:${o.digit}px">${digit}</text>` : ''
      // offset-distance fija: es lo que se ve si la animación está desactivada
      out.push(`<g class="bit" style="offset-path:path('${d}');offset-distance:${n(phase * 100)}%;animation-duration:${n(duration)}s;animation-delay:-${n(phase * duration)}s"><circle r="${o.halo}" fill="url(#glow-teal)"/>${cube}${label}</g>`)
    }
  })
  return out.join('')
}

const svg = (w, h, title, body, animated = true) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}"><title>${title}</title><defs>${DEFS}</defs><style>${STYLE(animated)}</style>${body}</svg>\n`

function logoBody(cx, cy, scale, digit = 21) {
  const P = projector({ yaw: -0.5, pitch: 0.2, dist: 15, scale, cx, cy })
  const r = rack(P, { seed: 11, bays: 4, grilleCols: 0, grilleRows: 0, brushed: 0, sideVents: 0, line: 1, led: n(scale * 0.095), screws: 0 })
  const zf = r.zf + 0.04
  const flow = streams(P, r, {
    seed: 11, fiber: n(scale * 0.05), cube: n(scale * 0.1), halo: n(scale * 0.27), bits: 2, digit, duration: 3.2,
    outer: [
      [[-2.55, r.slot(2) + 0.72, zf + 0.6], [-2.05, r.slot(2) + 0.25, zf + 0.5], [-1.75, r.slot(2), zf + 0.2], [-r.W / 2 + 0.1, r.slot(2), zf]],
      [[r.W / 2 - 0.1, r.slot(0), zf], [2.0, r.slot(0) - 0.03, zf + 0.25], [2.35, r.slot(0) - 0.32, zf + 0.5], [2.75, r.slot(0) - 0.7, zf + 0.45]]
    ]
  })
  const [fx, fy] = P([0, -r.plateY - 0.12, 0.1])
  return `<ellipse cx="${n(fx)}" cy="${n(fy)}" rx="${n(scale * 2.5)}" ry="${n(scale * 0.5)}" fill="url(#shadow)"/>${r.body}${flow}`
}

function heroBody() {
  // Proporción de la banda donde se muestra: así el recorte no se come el rack
  const [W, H] = [1400, 300]
  const rand = random(5)
  let room = `<rect width="${W}" height="${H}" fill="url(#room)"/>`
  // Sala: filas de racks lejanos, con sus LEDs, y un suelo que se pierde en el fondo
  const horizon = 218
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const depth = i / 6
      const w = 92 - depth * 46
      const h = 186 - depth * 104
      const x = side < 0 ? 10 + i * (92 - i * 5.2) : W - 10 - w - i * (92 - i * 5.2)
      const y = horizon - h * 0.86
      const opacity = n(0.82 - depth * 0.46)
      room += `<g opacity="${opacity}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="2" fill="url(#far-rack)" stroke="#2a3038" stroke-width=".7"/>`
      const rows = 8
      for (let r = 0; r < rows; r++) {
        const ry = y + 7 + (r * (h - 12)) / rows
        room += `<rect x="${n(x + 3)}" y="${n(ry)}" width="${n(w - 6)}" height="${n(h / rows - 3)}" fill="#0c0f13" stroke="#1d2229" stroke-width=".5"/>`
        for (let l = 0; l < 4; l++) {
          const amber = rand() > 0.92
          const lx = x + 8 + (l * (w - 20)) / 4 + rand() * 3
          const size = n(1.3 + (1 - depth) * 1.2)
          room += `<circle class="${'abcs'[Math.floor(rand() * 4)]}" style="animation-delay:-${n(rand() * 3)}s" cx="${n(lx)}" cy="${n(ry + (h / rows - 3) / 2)}" r="${size}" fill="${amber ? '#ffb648' : '#7ff5e0'}"/>`
        }
      }
      room += '</g>'
    }
  }
  room += `<rect y="${horizon}" width="${W}" height="${H - horizon}" fill="url(#floor)"/>`
  for (let i = -16; i <= 16; i++) room += `<path d="M${W / 2 + i * 22} ${horizon}L${W / 2 + i * 150} ${H}" stroke="#4fc3b0" stroke-opacity=".08"/>`
  for (let i = 0; i < 7; i++) {
    const y = horizon + (H - horizon) * Math.pow(i / 7, 1.8)
    room += `<path d="M0 ${n(y)}H${W}" stroke="#4fc3b0" stroke-opacity=".08"/>`
  }
  room += `<ellipse cx="${W / 2}" cy="266" rx="430" ry="44" fill="url(#floor-glow)"/>`
  room = `<defs><linearGradient id="room" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#090c10"/><stop offset=".7" stop-color="#10151b"/><stop offset="1" stop-color="#090c10"/></linearGradient><linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141a20"/><stop offset="1" stop-color="#090c10"/></linearGradient><linearGradient id="far-rack" x1="0" x2="1"><stop offset="0" stop-color="#22272e"/><stop offset="1" stop-color="#14181d"/></linearGradient><radialGradient id="vignette" cx=".5" cy=".55" r=".72"><stop offset=".52" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".82"/></radialGradient></defs>${room}`

  const P = projector({ yaw: -0.5, pitch: 0.17, dist: 15, scale: 74, cx: W / 2 - 8, cy: 138 })
  const r = rack(P, { seed: 3, bays: 7, grilleCols: 13, grilleRows: 4, brushed: 60, sideVents: 8, line: 0.5, led: 7, screws: 1.4 })
  const zf = r.zf + 0.04
  const flow = streams(P, r, {
    seed: 3, fiber: 2.6, cube: 5.2, halo: 18, bits: 5, digit: 12, duration: 5.5,
    outer: [
      [[-7.6, r.slot(2) + 0.72, zf + 0.5], [-5, r.slot(2) + 0.4, zf + 1.4], [-2.8, r.slot(2) + 0.15, zf + 0.8], [-r.W / 2 + 0.1, r.slot(2), zf]],
      [[-7.5, r.slot(0) - 0.55, zf - 0.2], [-5, r.slot(0) - 0.4, zf + 1.2], [-2.8, r.slot(0) - 0.1, zf + 0.75], [-r.W / 2 + 0.1, r.slot(0), zf]],
      [[r.W / 2 - 0.1, r.slot(2), zf], [2.7, r.slot(2) + 0.12, zf + 0.55], [5.2, r.slot(2) + 0.5, zf + 0.4], [8.2, r.slot(2) + 0.85, zf - 1.3]],
      [[r.W / 2 - 0.1, r.slot(0), zf], [2.7, r.slot(0) - 0.1, zf + 0.55], [5.2, r.slot(0) - 0.45, zf + 0.5], [8.2, r.slot(0) - 0.7, zf - 1.2]]
    ]
  })
  const [fx, fy] = P([0, -r.plateY - 0.12, 0.1])
  return `${room}<ellipse cx="${n(fx)}" cy="${n(fy)}" rx="235" ry="34" fill="url(#shadow)"/>${r.body}${flow}<rect width="${W}" height="${H}" fill="url(#vignette)" pointer-events="none"/>`
}

const write = (path, content) => {
  writeFileSync(join(root, path), content)
  console.log(`${path}: ${Math.round(content.length / 1024)} KB`)
}
write('src/renderer/src/assets/cluster-logo.svg', svg(256, 256, 'Codycube', logoBody(128, 128, 49)))
write('src/renderer/src/assets/cluster-hero.svg', svg(1400, 300, 'Clúster de servidores moviendo datos', heroBody()))
const iconBackground = `<defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#242b34"/><stop offset="1" stop-color="#0b0e12"/></linearGradient><clipPath id="tile-clip"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath></defs><rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"/>`
write('resources/icon.svg', svg(1024, 1024, 'Codycube', `${iconBackground}<g clip-path="url(#tile-clip)">${logoBody(528, 512, 136, 0)}</g>`, false))
