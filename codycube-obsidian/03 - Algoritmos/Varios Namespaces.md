---
title: Varios Namespaces
description: Cómo se filtran tablas, resumen, Helm y arquitectura por varios namespaces a la vez
type: algoritmo
tags:
  - namespaces
  - watch
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[03 - Algoritmos/Disposición del Diagrama]]"
next: "[[03 - Algoritmos/Edición con Control de Concurrencia]]"
related:
  - "[[02 - Acceso al Clúster/Listas en Vivo]]"
---

# 🧺 Varios Namespaces

La API de Kubernetes no admite pedir una lista de **varios** namespaces en una sola petición: o uno, o todos. Hay dos maneras de resolverlo:

| Opción | Problema |
|---|---|
| Pedir todo el clúster y filtrar en la app | Exige permiso de lectura en todo el clúster y trae datos que no se van a ver |
| **Una lista por namespace y unirlas** ✅ | Más conexiones, pero basta con tener permiso en esos namespaces |

## Implementación

`useWatch(contextId, resource, namespaces)` en `src/renderer/src/lib/api.ts`:

1. Normaliza la selección: vacía o tipo sin namespace (`Node`, `ClusterRole`…) = **una** lista de todo.
2. Ordena y quita duplicados; la clave resultante decide cuándo reabrir las listas.
3. Abre un `resource:watch` por namespace y guarda el estado de cada parte.
4. Publica la unión: `items` concatenados, `loading` mientras alguna parte carga.
5. **Fallo parcial:** si solo fallan algunos namespaces se muestra lo demás con un aviso («`pagos`: forbidden»); solo si fallan todos aparece la pantalla de error.

La arquitectura (`readTopologyInput`) y Helm (`helm list` por namespace) siguen la misma regla.

## Selector

`NamespacePicker`: búsqueda, casillas, **solo** en cada fila para pasar a un único namespace con un clic, y «Todos» para vaciar la selección. La selección se aplica a tablas, resumen, Helm y arquitectura.

![[namespaces.png]]
