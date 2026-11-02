---
title: Cliente REST
description: KubeClient — peticiones autenticadas, descubrimiento de tipos, errores legibles y WebSocket
type: acceso
tags:
  - api
  - rest
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[02 - Acceso al Clúster/Kubeconfig y Contextos]]"
next: "[[02 - Acceso al Clúster/Listas en Vivo]]"
---

# 🌐 Cliente REST

Código: `src/main/kube-client.ts`.

`@kubernetes/client-node` se usa **solo** para `applyToHTTPSOptions`: resuelve certificados, token, plugins `exec` y proxy. Las peticiones las construye `KubeClient` sobre `https`, con cuatro formas:

| Método | Uso |
|---|---|
| `json<T>(path, opts)` | Lecturas y escrituras. Tiempo máximo de 30 s por defecto |
| `text(path, opts)` | Respuestas de texto (métricas, logs anteriores). Admite `maxBytes` |
| `stream(path, opts, onChunk)` | Respuestas largas: watch y logs con `follow` |
| `webSocket(path, query, protocols)` | `exec` y `portforward` |

## Rutas

`resourcePath(resource, namespace?, name?, subresource?)` construye cualquier ruta:

```
/api/v1/namespaces/tienda/pods/web-7d9/log
/apis/apps/v1/namespaces/tienda/deployments/payments/scale
/apis/ejemplo.dev/v1/namespaces/demo/gadgets/rojo
```

## Descubrimiento

`discover()` recorre `/api` y `/apis`, pide cada grupo **en todas sus versiones** (la preferida primero) y produce `ResourceType[]` con verbos, nombres cortos y si admite `scale`. `uniqueKinds()` deja una entrada por `grupo/kind` (la de la versión preferida) para el menú lateral. El resultado se guarda en memoria; `findKind(apiVersion, kind)` vuelve a descubrir una vez si no encuentra el tipo (un CRD recién instalado).

## Errores

| Situación | Mensaje |
|---|---|
| Respuesta `Status` de la API | Su `message` tal cual, en un `KubeApiError` con `status` y `reason` |
| `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, certificados | `explainNetworkError()` da una frase con el servidor: «El servidor https://… rechazó la conexión» |
| Respuesta mayor que `maxBytes` | «la respuesta supera N MB» |

## Objetos ligeros

`slim()` quita `metadata.managedFields` de cada objeto antes de enviarlo a la interfaz: en clústeres grandes reduce mucho el volumen del IPC y nadie los edita a mano.
