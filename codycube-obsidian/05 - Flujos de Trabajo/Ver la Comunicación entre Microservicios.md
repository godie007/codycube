---
title: Ver la Comunicación entre Microservicios
description: Usar la vista de arquitectura para entender quién habla con quién, cuánto y con qué errores
type: flujo
tags:
  - flujo
  - arquitectura
  - dapr
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[05 - Flujos de Trabajo/Conectar un Clúster]]"
next: "[[05 - Flujos de Trabajo/Editar Secrets y ConfigMaps]]"
related:
  - "[[04 - Interfaz/Arquitectura y Tráfico]]"
  - "[[03 - Algoritmos/Tráfico desde Dapr]]"
---

# 🛰️ Ver la Comunicación entre Microservicios

## Requisitos

- Para ver **tráfico**: Dapr con sidecars (`dapr.io/enabled: "true"`) y permiso `get` sobre `pods/proxy` en esos namespaces.
- Sin Dapr se ve igualmente la arquitectura **declarada**: Ingress, Services, cargas y dependencias por variables de entorno.

## Pasos

1. Elige los namespaces de la aplicación en el filtro (p. ej. `tienda`).
2. Abre **Clúster → Arquitectura**. La primera lectura fija la base; en la siguiente aparecen las tasas.
3. Lee el diagrama: grosor = peticiones por segundo; color = errores; discontinuo = solo declarado.

![[arquitectura.png]]

4. Pulsa una conexión para ver su desglose por resultado y la gráfica de tasa y errores.

![[arquitectura-conexion.png]]

5. Con muchos servicios, cambia a **Tabla** y ordena por tasa o por errores.

![[arquitectura-tabla.png]]

## Ejemplo: un destino caído

En la demo de `tests/dapr-demo.yaml` (`gateway → orders → payments`, con eventos de `orders` hacia `notifications` e `inventory`), `orders` invoca a `payments`. Si se escala `payments` a 0:

- La conexión `orders → payments` pasa a rojo.
- El desglose muestra **No entregada**: Dapr no llegó a enviar la petición, así que no hay respuesta que contar; Codycube lo deduce de los 5xx que el sidecar devolvió a la app.
- En el inspector del nodo `payments` se ven 0 pods listos.

> [!note] Qué no se ve
> La comunicación directa entre servicios **sin** Dapr no aparece como tráfico (solo como dependencia declarada si está en una variable). Istio y Linkerd no están soportados.
