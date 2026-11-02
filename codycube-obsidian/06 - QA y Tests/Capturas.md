---
title: Capturas
description: Cómo se generan de forma reproducible las capturas de la documentación y del README
type: qa
tags:
  - qa
  - documentacion
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[06 - QA y Tests/Clúster Desechable]]"
next: "[[Decisiones]]"
---

# 📸 Capturas

Las imágenes de esta bóveda y del README salen de `scripts/capturas.mjs`, que maneja la app real con Playwright contra el [[06 - QA y Tests/Clúster Desechable|clúster desechable]] con la demo de Dapr.

```bash
npm run build
KUBECONFIG=/tmp/test.yaml node scripts/capturas.mjs   # por defecto en codycube-obsidian/Adjuntos/capturas
```

## Qué hace

1. Se niega a correr si el contexto no es `codycube-test`.
2. Crea objetos de ejemplo con nombres creíbles: el Secret `pagos-credenciales` (valores enmascarados), una referencia `envFrom` desde `payments` para que «Usado por» tenga contenido y una release de Helm `monitor` en `demo` (instalada y actualizada, para que haya historial).
3. Abre la app a **1440 × 900** con un directorio de datos temporal.
4. Recorre las pantallas y oculta los avisos emergentes antes de cada captura.
5. Sustituye en la pantalla de inicio la ruta temporal del kubeconfig por `~/.kube/config`.
6. Al terminar borra lo que creó y deshace el parche de `payments`.

## Capturas

| Archivo | Pantalla |
|---|---|
| `bienvenida.png` | Inicio con el kubeconfig cargado |
| `resumen.png` | Resumen del clúster |
| `arquitectura.png` | Diagrama con tráfico real |
| `arquitectura-conexion.png` | Inspector de una conexión |
| `arquitectura-tabla.png` | Tabla de conexiones |
| `namespaces.png` | Filtro de varios namespaces sobre Pods |
| `deployment-registros.png` | Registros combinados de un Deployment |
| `terminal.png` | Terminal en un pod |
| `yaml.png` | Editor YAML |
| `configmap-usado-por.png` | «Usado por» en un ConfigMap |
| `secret-editor.png` | Editor de datos de un Secret |
| `secret-guardar.png` | Resumen de cambios antes de guardar |
| `secret-crear.png` | Formulario de credenciales de registro |
| `cambiar-imagen.png` | Cambiar imagen de un Deployment |
| `etiquetas.png` | Etiquetas y anotaciones |
| `nodo.png` | Detalle de un nodo |
| `nodo-taints.png` | Edición de taints |
| `crd.png` | Recurso personalizado con sus columnas |
| `helm.png` | Releases de Helm |

> [!tip] Regenerar
> Tras un cambio visual, vuelve a ejecutar el script: los nombres de archivo no cambian, así que la bóveda y el README se actualizan solos.
