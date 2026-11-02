---
title: Modelo de Datos
description: Tipos compartidos entre procesos — recursos, objetos, mensajes en vivo, topología y tráfico
type: arquitectura
tags:
  - arquitectura
  - tipos
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[01 - Arquitectura/Seguridad]]"
next: "[[01 - Arquitectura/Estudio de Freelens]]"
---

# 🧬 Modelo de Datos

Todo está en `src/shared/types.ts`.

## Recursos y objetos

| Tipo | Qué es |
|---|---|
| `ClusterContext` | Un contexto de un kubeconfig: `id` = `<id de archivo>/<nombre>`, servidor, usuario, namespace por defecto, si usa `exec` y si está autorizado, solo lectura |
| `ResourceType` | Un tipo anunciado por el descubrimiento: `group`, `version`, `plural`, `kind`, `namespaced`, `verbs`, `shortNames`, `scalable` |
| `KubeObject` | Un objeto tal cual lo devuelve la API, aligerado por `slim()` (sin `managedFields`) |
| `ObjectRef` | `{ resource, namespace?, name }`: identifica un objeto para leerlo o cambiarlo |

## Mensajes en vivo

```ts
type WatchMessage =
  | { watchId; kind: 'snapshot'; items: KubeObject[] }
  | { watchId; kind: 'events'; events: WatchEvent[] }      // ADDED · MODIFIED · DELETED
  | { watchId; kind: 'status'; state: 'live' | 'reconnecting'; error? }
  | { watchId; kind: 'error'; error: string }
```

## Arquitectura y tráfico

| Tipo | Campos clave |
|---|---|
| `TopologyNode` | `id` (`workload:ns/Kind/nombre`, `service:ns/nombre`, `component:ns/nombre`, `topic:ns/broker/tema`), `kind` (`ingress`, `service`, `workload`, `component`, `topic`, `external`), `ref` al objeto, `daprAppId`, `category` del componente, `parent` (un tema vive dentro de su broker), `pods` listos/total/deseados, `services` plegados al dibujar |
| `TopologyEdge` | `source`, `target`, `kind`, `evidence` (qué objeto o campo la declara), `observed` y `traffic?` |
| `TopologyEdgeKind` | `route`, `selects` y `declared` salen de la configuración; `invoke`, `publish`, `deliver` y `component` pueden además tener tráfico medido |
| `EdgeTraffic` | `rate` (por segundo, ventana de 30 s), `errorRatio`, `total`/`errors` acumulados, `p50Ms`/`p95Ms` (ventana de 60 s), `breakdown` por resultado y `history` (hasta 60 lecturas) |
| `TrafficSnapshot` | Nodos, aristas, `coverage` (sidecars leídos/esperados, fallos, si se truncó), `daprInstalled` y `warmingUp` (la primera lectura solo fija la base) |

> [!important] Declarado frente a medido
> `observed` distingue siempre una cosa de la otra. Una conexión medida sustituye a la misma conexión solo declarada.

## Administración

| Tipo | Uso |
|---|---|
| `ConfigUser` | Una carga que usa un ConfigMap o Secret: `resource`, `name`, `references` (p. ej. `variable PASS (web)`), `restartable` |
| `NodeTaint` | `{ key, value?, effect }` |
| `DeploymentRevision`, `DrainReport`, `HelmRelease`, `HelmRevision`, `PortForwardInfo`, `ApplyResult` | Resultados de las acciones correspondientes |
