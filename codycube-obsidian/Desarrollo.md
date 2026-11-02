---
title: Desarrollo
description: Preparar el entorno, comandos, estructura del código y convenciones de Codycube
type: guia
tags:
  - desarrollo
updated: 2026-11-02
up: "[[00 - Inicio]]"
related:
  - "[[06 - QA y Tests/Suite de Tests]]"
---

# 🧑‍💻 Desarrollo

## Requisitos

- macOS (Apple Silicon o Intel), Node.js 22 o superior.
- `kubectl` y Docker para las pruebas de extremo a extremo; `helm` para la sección de Helm.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm install` | Dependencias; `postinstall` comprueba que el binario de Electron está descargado |
| `npm run dev` | App en desarrollo con recarga |
| `npm run build` | Compila main, preload y renderer en `out/` |
| `npm run typecheck` | TypeScript estricto en los dos proyectos |
| `npm test` | Pruebas unitarias |
| `npm run package:mac` | Genera `dist/Codycube.app` (firma ad hoc) |
| `npm run install:mac` | La genera y la instala en `/Applications` |
| `node scripts/brand.mjs` | Regenera logo, imagen e icono SVG |
| `node scripts/capturas.mjs` | Regenera las capturas de la documentación |

## Estructura

```
src/main/       Proceso principal: único que ve credenciales y red
  index.ts        Ventana, IPC, handlers, vigilancia de kubeconfig, PATH
  kubeconfig.ts   Archivos cargados, contextos, autorización de exec, solo lectura
  kube-client.ts  REST, flujos y WebSocket autenticados; descubrimiento
  watch.ts        list + watch, lotes de eventos, relistado y reconexión
  actions.ts      Aplicar, editar, escalar, reiniciar, revertir, drenar, datos, imagen, taints…
  streams.ts      Registros, terminal y reenvío de puertos
  helm.ts         CLI de helm
  topology.ts     Arquitectura declarada
  prometheus.ts   Formato de métricas, contadores y percentiles
  traffic.ts      Lectura de sidecars y tasas por conexión
src/preload/    Puente mínimo (contextBridge)
src/shared/     Contrato tipado de la API interna
src/renderer/   Interfaz en React
  components/     Vistas: ClusterView, ResourceTable, Details, Architecture, DataPanel…
  lib/            Lógica pura: catálogo, formato, datos, filtros y disposición del grafo
scripts/        Empaquetado, marca y capturas
tests/          Unitarias, extremo a extremo y manifiestos de prueba
codycube-obsidian/  Esta documentación
```

## Añadir una operación

1. Declara el método en `Api` (`src/shared/types.ts`).
2. Impleméntalo en `src/main/actions.ts` (o el módulo que toque) y regístralo en `handlers` de `src/main/index.ts`. Si escribe, usa `writable(contextId)`.
3. Llámalo desde la interfaz con `invoke('metodo', …)`.
4. Pruébalo: unitaria si hay lógica pura; paso de extremo a extremo que compruebe el efecto con `kubectl`.

## Convenciones

- Todo texto visible, en **español**.
- Los errores que ve la persona dicen qué pasó y qué hacer («Recarga y vuelve a aplicar tu cambio»).
- Lógica pura en `lib/` o en funciones exportadas de `src/main/`: así se prueba sin clúster.
- Ningún valor de Secret en registros, avisos ni diffs.
- Comentarios en el código explican el **porqué**, no el qué.
