---
title: Marca
description: Logo, imagen panorámica e icono de Codycube — SVG animados generados desde un modelo geométrico del rack
type: interfaz
tags:
  - marca
  - svg
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[04 - Interfaz/Editor de Datos]]"
next: "[[05 - Flujos de Trabajo/Conectar un Clúster]]"
---

# 🎨 Marca

![[banner.svg]]

| Archivo | Uso |
|---|---|
| `src/renderer/src/assets/cluster-logo.svg` | Logo animado (barra de clústeres, inicio, estados vacíos) |
| `src/renderer/src/assets/cluster-hero.svg` | Imagen panorámica del clúster en su sala (pantalla de inicio) |
| `resources/icon.svg` → `resources/icon.png` | Icono de la app: un fotograma fijo sobre fondo redondeado |

![[logo.svg|160]]

## Cómo se generan

`scripts/brand.mjs` modela el rack en 3D (bastidor, servidores, LEDs, cables, partículas de datos) y lo **proyecta en perspectiva** a 2D. Usa un aleatorio con semilla: regenerar produce exactamente los mismos archivos, así que los cambios se revisan en el diff.

```bash
node scripts/brand.mjs         # los tres SVG
npx electron scripts/icon.cjs  # resources/icon.png desde icon.svg (lo usa package-mac.sh)
```

## Animación segura

- La animación es **CSS dentro del SVG**. Se cargan con `<img>`, que no ejecuta código: quedan aisladas de la app y cumplen la CSP.
- El navegador las detiene solo cuando no se ven.
- Respetan `prefers-reduced-motion: reduce`.
- Son decorativas (`alt=""`): quien las usa pone su propia etiqueta accesible.
