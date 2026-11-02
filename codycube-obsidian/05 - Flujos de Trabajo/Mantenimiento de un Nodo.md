---
title: Mantenimiento de un Nodo
description: Acordonar, drenar respetando los PodDisruptionBudget, aplicar taints y volver a habilitar un nodo
type: flujo
tags:
  - flujo
  - nodos
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[05 - Flujos de Trabajo/Desplegar una Nueva Imagen]]"
next: "[[05 - Flujos de Trabajo/Depurar un Pod]]"
related:
  - "[[02 - Acceso al Clúster/Acciones de Escritura]]"
---

# 🛠️ Mantenimiento de un Nodo

![[nodo.png]]

1. **Clúster → Nodos**, elige el nodo.
2. **Drenar**: acordona el nodo y desaloja sus pods con la API `Eviction`, que **respeta los PodDisruptionBudget**. Si un PDB no lo permite todavía, se reintenta cada 5 s durante un minuto.
   - No se tocan pods estáticos ni de DaemonSet.
   - Un pod sin controlador se perdería: solo se desaloja marcando **forzar**.
3. Lee el informe: desalojados, omitidos (con motivo) y fallidos (con error).
4. Haz el mantenimiento.
5. **Habilitar** para que vuelva a recibir pods.

## Reservar un nodo con taints

**Taints** edita la lista `clave=valor:Efecto`, uno por línea:

```
dedicado=gpu:NoSchedule
mantenimiento:NoExecute
```

![[nodo-taints.png]]

| Efecto | Qué hace |
|---|---|
| `NoSchedule` | No se programan pods nuevos sin la tolerancia |
| `PreferNoSchedule` | Se evita si hay alternativa |
| `NoExecute` | Además expulsa los pods que ya están y no lo toleran |
