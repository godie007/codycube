---
title: Arquitectura y Tráfico
description: La vista de arquitectura — diagrama en vivo, leyenda, KPIs, inspector de conexión y de nodo, tabla de conexiones
type: interfaz
tags:
  - interfaz
  - arquitectura
  - trafico
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[04 - Interfaz/Distribución de la Ventana]]"
next: "[[04 - Interfaz/Tablas y Detalles]]"
related:
  - "[[03 - Algoritmos/Tráfico desde Dapr]]"
  - "[[03 - Algoritmos/Disposición del Diagrama]]"
  - "[[05 - Flujos de Trabajo/Ver la Comunicación entre Microservicios]]"
---

# 🛰️ Arquitectura y Tráfico

Código: `src/renderer/src/components/Architecture.tsx`.

![[arquitectura.png]]

## Barra superior

| Control | Uso |
|---|---|
| Buscar servicio | Resalta los nodos cuyo nombre coincide |
| Diagrama / Tabla | Cambia entre el grafo y la tabla de conexiones |
| Frecuencia | Lectura cada 5, 10 o 30 s |
| Pausar / Reanudar | Detiene las lecturas (útil para leer una cifra) |
| KPIs | Invocaciones/s, eventos publicados/s, % con error, apps con Dapr y sidecars leídos |
| Filtros | **Solo con tráfico medido**, **Dependencias declaradas**, **Sistema** (ver [[03 - Algoritmos/Disposición del Diagrama\|Disposición]]) |

## Diagrama

- **Tarjetas** por carga con el tipo, réplicas listas/deseadas, si lleva Dapr y los Services plegados en ella. Componentes de Dapr con su tipo; los temas aparecen **dentro** de su broker.
- Al pasar el ratón o elegir un nodo se atenúa todo lo que no es su vecindad.
- **Aristas**: el grosor es la tasa; el color, el porcentaje de error; las animadas tienen tráfico ahora mismo; las discontinuas solo están declaradas.
- **Pan y zoom** con el ratón o el trackpad; botones `+`, `−` y **Ajustar**. Tras ajustar a mano, una relectura no mueve la vista.
- Las partículas que recorren cada arista aumentan en número y velocidad con la tasa (de 1 a 4). Con `prefers-reduced-motion` no se animan.

| Color | Significado |
|---|---|
| 🟢 Verde | Tráfico sano |
| 🟡 Ámbar | Errores ≥ 1 % |
| 🔴 Rojo | Errores ≥ 5 % |
| ⚪ Gris continuo | Medida, sin tráfico ahora |
| ⚪ Gris discontinuo | Declarada, sin medir |

## Inspector de conexión

Al elegir una arista: origen y destino, tipo (invocación, publicación, entrega, componente), tasa, % de error, p50/p95, acumulados desde que arrancaron los sidecars, **desglose por resultado** (`HTTP 200`, `HTTP 503`, `No entregada`, `Reintento`…) y una gráfica de tasa total y de errores con cruz de lectura. Una sola escala: las dos series miden peticiones por segundo.

![[arquitectura-conexion.png]]

## Inspector de nodo

Namespace, app-id de Dapr, tipo de componente, pods listos de los deseados, los Services plegados (cada uno abre su detalle) y un botón para abrir el objeto.

## Tabla de conexiones

La misma información como tabla ordenable: útil con muchos servicios o para comparar cifras.

![[arquitectura-tabla.png]]

## Avisos

- **Lectura parcial**: si algún sidecar no responde se dicen los motivos (sin permiso `pods/proxy`, métricas desactivadas, tiempo agotado…) y que el tráfico mostrado puede estar por debajo del real.
- **Dapr no instalado**: se dibuja solo lo declarado y se explica por qué no hay tráfico.
- **Calentando**: la primera lectura solo fija la base; las tasas aparecen en la siguiente.
