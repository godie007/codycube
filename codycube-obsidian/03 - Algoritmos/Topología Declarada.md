---
title: Topología Declarada
description: Qué deduce buildTopology de los objetos del clúster — cargas, Services, Ingress, componentes y suscripciones de Dapr, dependencias por variables
type: algoritmo
tags:
  - arquitectura
  - topologia
  - dapr
updated: 2026-11-02
up: "[[00 - Inicio]]"
next: "[[03 - Algoritmos/Tráfico desde Dapr]]"
related:
  - "[[04 - Interfaz/Arquitectura y Tráfico]]"
---

# 🕸️ Topología Declarada

Código: `buildTopology()` en `src/main/topology.ts`. Es una función pura: recibe listas de objetos (`TopologyInput`) y devuelve nodos, aristas y un índice `<namespace>/<app-id>` → nodo para colocar después el tráfico medido.

## Entrada

`readTopologyInput()` lee en paralelo Deployments, StatefulSets, DaemonSets, Pods, ReplicaSets, Services, Ingress y, si Dapr está instalado, `components.dapr.io` y `subscriptions.dapr.io`. Con varios namespaces elegidos pide cada uno por separado. Un tipo que falla se convierte en aviso y el resto se dibuja igual.

## Reglas

| Paso | Regla | Arista | `evidence` |
|---|---|---|---|
| 1. Cargas | Cada pod sube a su dueño final (Pod → ReplicaSet → Deployment, o StatefulSet / DaemonSet). Un pod suelto con Dapr o sin dueño se dibuja solo | — | — |
| 2. Services | Su `selector` se compara con las etiquetas de la plantilla de cada carga. Sin selector (como `kubernetes`) no se dibuja; los Services `<app>-dapr` que crea Dapr tampoco, porque duplicarían cada app | `selects` | selector del Service |
| 3. Ingress | Cada `backend.service.name` de sus reglas | `route` | regla del Ingress |
| 4. Variables | Un valor de `env` que es la dirección de un Service conocido: `http://orders`, `orders:8080`, `orders.tienda:8080` u `orders.tienda.svc.cluster.local`. Una palabra suelta como `orders` **no** cuenta (falso positivo casi seguro) y `api.ejemplo.com` es externo | `declared` | `variable ORDERS_URL` |
| 5. Componentes | Nodo por componente con su tipo (`pubsub.redis`, `state.redis`…). Sus `scopes` lo enlazan a las apps; un valor literal de su `metadata` que apunta a un Service lo enlaza a él | `declared` | scopes del componente · `metadata redisHost` |
| 6. Suscripciones | Cada `Subscription` crea el tema **dentro** de su broker y lo enlaza a las apps de sus `scopes` | `deliver` | `Subscription <nombre>` |

> [!important] Nunca se leen secretos
> De las variables solo se usa el **nombre** como evidencia, nunca el valor. De los componentes solo se miran valores literales (`value`), no `secretKeyRef`.

## Por qué así

Lo declarado responde «qué *debería* hablar con qué». Se dibuja en línea discontinua y se oculta en cuanto el mismo par tiene tráfico medido (ver [[03 - Algoritmos/Disposición del Diagrama|Disposición del diagrama]]). Así el diagrama es útil incluso sin tráfico, y nunca presenta una suposición como un hecho.
