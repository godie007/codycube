---
title: Registros, Terminal y Puertos
description: Flujos de logs con follow, terminal exec sobre WebSocket y reenvío de puertos local
type: acceso
tags:
  - logs
  - exec
  - port-forward
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[02 - Acceso al Clúster/Listas en Vivo]]"
next: "[[02 - Acceso al Clúster/Acciones de Escritura]]"
related:
  - "[[05 - Flujos de Trabajo/Depurar un Pod]]"
---

# 📜 Registros, Terminal y Puertos

Código: `src/main/streams.ts`.

## Registros

- `streamLogs` abre **una petición por contenedor** con `follow=true` y `timestamps=true`. Para un Deployment, Service, Job… primero resuelve sus pods (`podsFor`, por selector) y une los flujos.
- `parseLogLine` separa la marca de tiempo que antepone el servidor para poder ordenar y mostrarla u ocultarla.
- Las líneas se envían en lotes de 100 ms por `codycube:logs`.
- **Ejecución anterior** (`previous=true`) no usa `follow`: ese contenedor ya terminó.
- Si un contenedor se reinicia, el servidor cierra el flujo: llega un mensaje `end` y la pestaña ofrece **Reanudar**.
- La pestaña conserva las últimas 50 000 líneas, permite filtrar, mostrar marcas de hora y descargar.

![[deployment-registros.png]]

## Terminal

- WebSocket a `pods/<pod>/exec` con el subprotocolo `v4.channel.k8s.io`: el primer byte de cada mensaje es el canal (0 stdin, 1 stdout, 2 stderr, 3 estado, 4 tamaño).
- Comando: `command -v bash && exec bash || exec sh`, para que funcione en imágenes mínimas.
- El tamaño de xterm se envía por el canal 4 al abrir y en cada cambio de tamaño.
- No hace falta `kubectl` ni el módulo nativo `node-pty`.

![[terminal.png]]

> [!warning] La terminal cuenta como escritura
> Abrir una shell permite cambiar cualquier cosa dentro del pod: el modo solo lectura la bloquea.

## Reenvío de puertos

- `PortForwards` abre un servidor TCP en **127.0.0.1** (puerto elegido o uno libre) y, por cada conexión, un WebSocket a `pods/<pod>/portforward`.
- Para un Service elige un pod listo (`isPodReady`) y traduce el puerto del Service al del contenedor (`resolveTargetPort`, también con puertos con nombre), como `kubectl port-forward`.
- La lista de reenvíos activos se publica por `codycube:forwards`; se cierran al quitar el clúster y al salir de la app.
