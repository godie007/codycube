---
title: Suite de Tests
description: Pruebas unitarias con vitest y de extremo a extremo con Playwright sobre la app real y un clúster desechable
type: qa
tags:
  - qa
  - tests
updated: 2026-11-02
up: "[[00 - Inicio]]"
next: "[[06 - QA y Tests/Clúster Desechable]]"
related:
  - "[[Desarrollo]]"
---

# 🧪 Suite de Tests

| Suite | Archivo | Qué cubre | Necesita |
|---|---|---|---|
| Unitarias | `tests/unit.test.ts` (42) | Rutas de la API, flujos línea a línea, YAML, cantidades (CPU y memoria), selectores, drenado, reenvío de puertos, kubeconfig, formato de Prometheus, tráfico de Dapr, arquitectura declarada y distribución del diagrama | Nada |
| Unitarias | `tests/config-data.test.ts` (11) | base64 y UTF-8, binarios, diff de claves, `.env`, `.dockerconfigjson`, claves por tipo de Secret, etiquetas, taints, validación de claves y «Usado por» (`configReferences`) | Nada |
| Extremo a extremo | `tests/e2e.mjs` (32 pasos) | Seguridad de la ventana, kubeconfig, todas las secciones, tablas en vivo, logs, escalar, reiniciar, revertir, terminal, reenvío de puertos, YAML (simular, aplicar, conflictos), eliminar, CronJob, CRD, varios namespaces, drenado, solo lectura, puente | Clúster desechable, `helm` |
| Arquitectura | `tests/e2e-architecture.mjs` (15 pasos) | Topología declarada, tráfico real en todos los caminos, % de error, estabilidad del diagrama, inspector, tabla frente a contadores del sidecar, filtros, búsqueda, varios namespaces, destino caído, pausa, sin permiso `pods/proxy` | Clúster con Dapr y la demo |
| Administración | `tests/e2e-admin.mjs` (11 pasos) | «Usado por», editor de ConfigMap, `.env`, conflicto, Secret en claro y binarios intactos, Secret de registro, inmutable, etiquetas, imagen, pausa, taints, solo lectura | Clúster con la demo |
| Distribución | `tests/e2e-responsive.mjs` | Sin desbordamientos ni recortes en 1920 × 1080, 1440 × 900, 1200 × 760 y 960 × 600 | Clúster con la demo |
| App empaquetada | `tests/smoke-packaged.mjs` | Arranque de `dist/Codycube.app` y recuperación de una tabla cuando el servidor de API se reinicia | `npm run package:mac` |

## Reglas

- Las pruebas de extremo a extremo **se niegan a correr** si el contexto actual no se llama `codycube-test`: nunca tocan un clúster real.
- Manejan la **app real** (`_electron.launch` de Playwright) con un directorio de datos temporal.
- Cada paso comprueba el efecto en el clúster con `kubectl`, no solo en pantalla.
- Limpian lo que crean.

## Comandos

```bash
npm run typecheck
npm test                         # unitarias
npx electron-vite build
node tests/e2e-architecture.mjs  # antes que e2e.mjs (ver abajo)
node tests/e2e-admin.mjs
node tests/e2e-responsive.mjs
node tests/e2e.mjs
npm run package:mac && node tests/smoke-packaged.mjs
```

> [!warning] Orden
> `e2e.mjs` drena el nodo. En un clúster de un solo nodo, los pods de `tienda` vuelven sin sidecar de Dapr hasta que se reinician. Corre la de arquitectura primero, o después ejecuta `kubectl -n tienda rollout restart deploy`.
>
> Para correr `e2e.mjs` con Dapr instalado, borra antes el `PodDisruptionBudget` de `dapr-system`: el del scheduler no admite desalojos y el drenado agota sus reintentos.
