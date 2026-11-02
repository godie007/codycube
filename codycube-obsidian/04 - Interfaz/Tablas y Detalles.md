---
title: Tablas y Detalles
description: Tablas de recursos en vivo con columnas por tipo y CRD, y el panel de detalles con acciones
type: interfaz
tags:
  - interfaz
  - tablas
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[04 - Interfaz/Arquitectura y Tráfico]]"
next: "[[04 - Interfaz/Editor de Datos]]"
---

# 📋 Tablas y Detalles

## Tablas

Código: `ResourceTable.tsx` y las columnas de `lib/catalog.tsx`.

- Una tabla en vivo por cada tipo que anuncia el clúster. Los tipos nativos tienen columnas propias (Pods: listos, estado, reinicios, nodo, IP; Deployments: listos, actualizados, disponibles, estrategia; CronJobs: programación, suspendido, última ejecución…).
- Los **CRD** usan sus `additionalPrinterColumns`, como `kubectl get`.
- Búsqueda por nombre o etiqueta (`app=web`), orden por columna, selección múltiple para eliminar.
- **Crear** abre el editor de datos para ConfigMaps y Secrets, y una plantilla YAML para el resto.
- Avisos no bloqueantes cuando la lista se está reconectando o falla algún namespace.

![[namespaces.png]]

![[crd.png]]

## Panel de detalles

Código: `Details.tsx`.

| Sección | Contenido |
|---|---|
| Acciones | Botones según el tipo y los verbos que permite la API (ver tabla abajo) |
| Metadatos | Namespace, edad, etiquetas, anotaciones (sin `last-applied-configuration`), dueños |
| Condiciones | Tipo, estado, motivo y mensaje |
| Contenedores | Imagen, estado, reinicios, puertos, recursos, sondas |
| Usado por | En ConfigMaps y Secrets, qué cargas los usan y cómo |
| Datos | Claves de ConfigMaps y Secrets; en Secrets ocultas hasta pedirlas, con **Copiar** |
| Servicio / Nodo | Puertos y endpoints; capacidad, asignable, taints y condiciones |
| Eventos | Los del objeto, más recientes primero |

| Tipo | Acciones |
|---|---|
| Todos | YAML, Etiquetas, Eliminar |
| Pod | Registros, Terminal, Reenviar puerto, Cambiar imagen, Forzar eliminación |
| Deployment | Escalar, Reiniciar, Revertir, Pausar/Reanudar despliegue, Cambiar imagen, Registros |
| StatefulSet / DaemonSet | Escalar (StatefulSet), Reiniciar, Cambiar imagen, Registros |
| CronJob | Suspender/Reanudar, Ejecutar ahora, Cambiar imagen |
| Node | Acordonar/Habilitar, Drenar, Taints |
| Service | Reenviar puerto, Registros |
| ConfigMap / Secret | Editar datos (Ver datos si es inmutable o en solo lectura) |

![[cambiar-imagen.png]]

![[etiquetas.png]]
