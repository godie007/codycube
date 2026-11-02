---
title: Desplegar una Nueva Imagen
description: Cambiar la imagen de una carga, seguir el despliegue, pausarlo y revertir
type: flujo
tags:
  - flujo
  - despliegue
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[05 - Flujos de Trabajo/Editar Secrets y ConfigMaps]]"
next: "[[05 - Flujos de Trabajo/Mantenimiento de un Nodo]]"
related:
  - "[[02 - Acceso al Clúster/Acciones de Escritura]]"
---

# 🚀 Desplegar una Nueva Imagen

1. **Cargas de trabajo → Deployments**, elige el Deployment.
2. **Cambiar imagen**: un campo por contenedor (también los init). Solo se envían los que cambian, como `kubectl set image`.

![[cambiar-imagen.png]]

3. Sigue el despliegue en la tabla (listos / actualizados / disponibles) y en **Registros**, que combina todos los pods.

![[deployment-registros.png]]

4. ¿Algo va mal?
   - **Pausar despliegue** congela el rollout donde está para investigar.
   - **Revertir** lista las revisiones con su imagen y fecha; elegir una restaura su plantilla.
5. **Reanudar despliegue** cuando esté listo.

> [!tip] Varios cambios a la vez
> Pausa, cambia imagen, recursos o variables (por YAML) y reanuda: se aplica todo en un único rollout.
