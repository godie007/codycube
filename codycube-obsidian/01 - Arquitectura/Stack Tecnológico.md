---
title: Stack Tecnológico
description: Dependencias de Codycube, sus versiones y el motivo de cada una
type: arquitectura
tags:
  - arquitectura
  - dependencias
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[01 - Arquitectura/Visión General]]"
next: "[[01 - Arquitectura/Procesos e IPC]]"
---

# 🧰 Stack Tecnológico

| Pieza | Versión | Para qué |
|---|---|---|
| Electron | 44 | Ventana de escritorio, IPC y empaquetado |
| electron-vite | 6 | Compila main, preload y renderer con Vite |
| React | 19 | Interfaz |
| TypeScript | 7 | Tipado estricto en los dos proyectos (`tsconfig.node.json`, `tsconfig.web.json`) |
| `@kubernetes/client-node` | 2 | **Solo** para resolver la autenticación del kubeconfig (token, certificados, plugins `exec`, proxy). Las peticiones las hace `KubeClient` |
| `ws` | 8 | WebSocket para `exec` (terminal) y `portforward` |
| `js-yaml` | 4 | Leer y escribir YAML de objetos y de varios documentos |
| CodeMirror 6 | 6 | Editor YAML con resaltado y tema oscuro |
| xterm.js | 6 | Terminal en el pod |
| elkjs | 0.12 | Disposición por capas del diagrama de arquitectura |
| vitest | — | Pruebas unitarias |
| Playwright (`playwright-core`) | — | Pruebas de extremo a extremo sobre la app real (`_electron`) |

## Por qué así

- **REST directo en vez de las clases generadas del cliente oficial.** Un único camino (`resourcePath` + `json`/`stream`/`webSocket`) sirve para cualquier tipo, también para los CRD que el clúster anuncia en tiempo de ejecución. Ver [[02 - Acceso al Clúster/Cliente REST|Cliente REST]].
- **Todo dentro de los bundles.** Las dependencias del proceso principal también se empaquetan con Vite: la app instalada no necesita `node_modules`.
- **Sin Prometheus para el tráfico.** Las métricas se leen de cada sidecar a través del servidor de API. Ver [[03 - Algoritmos/Tráfico desde Dapr|Tráfico desde Dapr]].
- **SVG a mano para el diagrama.** ELK calcula posiciones; el dibujo, la animación y el pan/zoom son propios para controlar calidad y rendimiento.
