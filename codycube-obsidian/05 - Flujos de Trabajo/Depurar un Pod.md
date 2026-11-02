---
title: Depurar un Pod
description: Del pod que falla a la causa — estado, eventos, registros, ejecución anterior, terminal y reenvío de puertos
type: flujo
tags:
  - flujo
  - depuracion
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[05 - Flujos de Trabajo/Mantenimiento de un Nodo]]"
next: "[[05 - Flujos de Trabajo/Releases de Helm]]"
related:
  - "[[02 - Acceso al Clúster/Registros, Terminal y Puertos]]"
---

# 🐞 Depurar un Pod

1. **Resumen** lista los pods con problemas (CrashLoopBackOff, ImagePullBackOff, pendientes…) y las advertencias recientes. Pulsa uno.
2. En detalles mira **Condiciones**, el estado y los reinicios de cada **Contenedor** y los **Eventos** (falta de recursos, sondas fallidas, imagen no encontrada).
3. **Registros**: elige contenedor; si se reinició, activa **Ejecución anterior** para ver por qué murió. Filtra líneas y descarga si hace falta.

![[deployment-registros.png]]

4. **Terminal**: una shell en el contenedor (bash si existe, si no sh) para mirar archivos, variables o conectividad.

![[terminal.png]]

5. **Reenviar puerto** para probar el servicio desde tu equipo en `127.0.0.1`.
6. **YAML** para revisar o corregir la especificación; un cambio simultáneo de otra persona da conflicto en lugar de perderse.

![[yaml.png]]
