---
title: Disposición del Diagrama
description: Plegado de Services, filtros y disposición por capas con ELK para el diagrama de arquitectura
type: algoritmo
tags:
  - arquitectura
  - elk
  - layout
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[03 - Algoritmos/Tráfico desde Dapr]]"
next: "[[03 - Algoritmos/Varios Namespaces]]"
related:
  - "[[04 - Interfaz/Arquitectura y Tráfico]]"
---

# 📐 Disposición del Diagrama

Código: `src/renderer/src/lib/graph-filter.ts` y `src/renderer/src/lib/graph-layout.ts`.

## 1. Plegar Services

Un Service que selecciona **una sola** carga es su puerta de entrada, no otra pieza de la arquitectura. `collapseServices`:

- Lo quita y añade su nombre a `services` de la carga (se muestra en la tarjeta).
- Redirige sus aristas a la carga y fusiona las repetidas.
- Elimina una arista `declared` si el mismo par ya tiene una medida.

Los Services que reparten entre varias cargas, o que no tienen ninguna, se conservan.

> [!tip] Por qué
> Dibujar cada Service añade una columna por servicio y obliga a reducir todo el diagrama hasta que no se lee.

## 2. Filtrar

| Filtro | Efecto |
|---|---|
| **Declarado** | Muestra u oculta las aristas solo declaradas (`route` y `selects` se ven siempre) |
| **Solo con tráfico** | Deja aristas medidas y los nodos que tocan; un broker se conserva si alguno de sus temas tiene tráfico |
| **Sistema** | Oculta `kube-system`, `dapr-system`, `cert-manager`, `ingress-nginx`… salvo que se hayan elegido a propósito en el filtro de namespaces |

El filtrado **nunca depende de las tasas**: el grafo no salta en cada lectura.

## 3. Disponer con ELK

`layoutGraph` usa `elkjs` (algoritmo `layered`):

| Opción | Valor |
|---|---|
| Dirección | Izquierda → derecha; arriba → abajo cuando el lienzo es estrecho (se mide con `ResizeObserver`) |
| Enrutado | Ortogonal, con esquinas redondeadas (`roundedPath`) |
| Jerarquía | `INCLUDE_CHILDREN`: los temas se colocan **dentro** de su broker |
| Tamaños | Tarjeta 196 × 62, tema 160 × 36 |
| Espaciado entre capas | 130 px (horizontal) / 74 px (vertical) |

`layoutKey` resume nodos y aristas: la disposición solo se recalcula cuando cambia la estructura, no cuando cambian las tasas. La etiqueta de cada arista va en el centro de su tramo más largo (`longestSegmentMiddle`).
