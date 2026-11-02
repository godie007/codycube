---
title: Distribución de la Ventana
description: Pantalla de inicio, barra de clústeres, menú lateral, contenido, panel de detalles y dock de pestañas; comportamiento a distintos tamaños
type: interfaz
tags:
  - interfaz
  - responsive
updated: 2026-11-02
up: "[[00 - Inicio]]"
next: "[[04 - Interfaz/Arquitectura y Tráfico]]"
related:
  - "[[01 - Arquitectura/Visión General]]"
---

# 🪟 Distribución de la Ventana

## Inicio

Lista de kubeconfig cargados y sus contextos, con servidor, usuario y estado (autorizar `exec`, solo lectura). Botones **Cargar kubeconfig** y **Pegar texto**; también se puede soltar un archivo sobre la ventana.

![[bienvenida.png]]

## Con un clúster abierto

```
┌────────┬───────────────────────────────────────────────┐
│ Barra  │  Menú lateral │  Contenido          │ Detalles │
│ de     │  Namespaces ▾ │  (tabla, resumen,   │ (al      │
│ clúst. │  Clúster      │   arquitectura…)    │  elegir) │
│        │  Cargas       │                     │          │
│        │  Config. …    ├─────────────────────┴──────────┤
│        │               │  Dock: Registros · Terminal ·  │
│        │               │  YAML · Datos · Aplicar        │
└────────┴───────────────┴────────────────────────────────┘
```

| Zona | Contenido |
|---|---|
| Barra de clústeres | Un icono por clúster abierto; se pueden tener varios a la vez y cada uno conserva su estado |
| Menú lateral | Filtro de namespaces y secciones: Clúster (Resumen, Arquitectura, Nodos, Namespaces, Eventos), Cargas de trabajo, Configuración, Red, Almacenamiento, Control de acceso, Helm y Recursos personalizados (agrupados por grupo de API) |
| Contenido | La página elegida |
| Detalles | Panel del objeto seleccionado con sus acciones |
| Dock | Pestañas redimensionables: registros, terminal, edición YAML, datos de ConfigMap/Secret y aplicar YAML. Abrir algo que ya está abierto reutiliza su pestaña |

![[resumen.png]]

## Tamaños

Probado con `tests/e2e-responsive.mjs` (29 comprobaciones en cuatro tamaños: 1920 × 1080, 1440 × 900, 1200 × 760 y 960 × 600): sin desbordamientos horizontales, sin elementos recortados y con el diagrama utilizable.

| Regla | Desde |
|---|---|
| Panel de detalles **flotante** sobre el contenido (ancho `min(460px, 82 %)`) y menú lateral más estrecho | ≤ 1240 px de ancho |
| Leyenda del diagrama compacta | ≤ 1240 px de ancho |
| Barras y cifras más bajas para dejar altura al diagrama | ≤ 720 px de alto |
| Diagrama en vertical (arriba → abajo) | lienzo estrecho |
| Filas del editor de datos en una columna | ≤ 900 px de ancho |

La ventana mínima es de 960 × 600.
