---
title: Decisiones
description: Registro de decisiones de diseño de Codycube y sus motivos
type: decisiones
tags:
  - decisiones
  - arquitectura
updated: 2026-11-02
up: "[[00 - Inicio]]"
---

# 🧭 Decisiones

## Estudiar Freelens, no Lens

**Decisión:** entender cómo funciona un cliente tipo Lens estudiando **Freelens 2.0.0** (MIT), con análisis estático y su código fuente ([[01 - Arquitectura/Estudio de Freelens]]).
**Motivo:** la licencia de Lens Desktop prohíbe la ingeniería inversa. Freelens viene del mismo origen (OpenLens) y su código es público.
**Consecuencia:** no se analiza ni descompila `Lens.app`. Codycube no copia código de Freelens: se escribió desde cero.

## Interfaz sin Node y con CSP estricta

**Decisión:** `sandbox`, `contextIsolation`, sin `nodeIntegration`, un solo canal IPC con lista cerrada de métodos ([[01 - Arquitectura/Seguridad]]).
**Motivo:** la interfaz muestra datos que controla el clúster (logs, anotaciones, YAML). Freelens da Node a la interfaz: un XSS ahí alcanzaría credenciales y sistema.
**Costo:** cada capacidad nueva necesita un método tipado en `Api` y su handler.

## REST directo, sin proxy ni binarios

**Decisión:** un `KubeClient` mínimo sobre `https`; `@kubernetes/client-node` solo para autenticar ([[02 - Acceso al Clúster/Cliente REST]]).
**Motivo:** un único camino genérico sirve para cualquier tipo, incluidos los CRD; no hay que empaquetar `kubectl` ni un proxy por clúster.
**Costo:** exec y port-forward se implementan sobre WebSocket a mano.

## Modo solo lectura en el proceso principal

**Decisión:** `writable(contextId)` en cada handler que escribe.
**Motivo:** ocultar botones no protege: cualquier ruta de código debe pasar por la misma comprobación. Las pruebas llaman al puente directamente para comprobarlo.

## Autorizar plugins `exec`

**Decisión:** pedir autorización del comando concreto por contexto antes de ejecutarlo.
**Motivo:** un kubeconfig ajeno puede ejecutar cualquier programa al conectar.

## Logs con `follow`, no sondeo

**Decisión:** una petición `follow=true` por contenedor ([[02 - Acceso al Clúster/Registros, Terminal y Puertos]]).
**Motivo:** Freelens consulta cada 10 s; con `follow` las líneas llegan al instante y el servidor no recibe consultas repetidas.

## Tráfico desde los sidecars de Dapr, sin Prometheus

**Decisión:** leer `/metrics` de cada sidecar vía `pods/proxy` y calcular tasas en la app ([[03 - Algoritmos/Tráfico desde Dapr]]).
**Motivo:** funciona en cualquier clúster con Dapr sin instalar nada más y sin abrir puertos; también en modo solo lectura.
**Costo:** solo se ve lo que pasa por Dapr; el histórico dura lo que la vista esté abierta (60 lecturas).

## Separar lo declarado de lo medido

**Decisión:** aristas `observed` en línea continua; las deducidas de objetos, discontinuas; una medida sustituye a la declarada.
**Motivo:** un diagrama que mezcla suposiciones con hechos engaña. La evidencia de cada arista declarada (`variable ORDERS_URL`) dice de dónde sale.

## Plegar Services de una sola carga

**Decisión:** integrar en la tarjeta de su carga los Services que solo la seleccionan a ella ([[03 - Algoritmos/Disposición del Diagrama]]).
**Motivo:** cada Service añadía una columna y obligaba a encoger el diagrama hasta hacerlo ilegible.

## Una lista en vivo por namespace

**Decisión:** el filtro de varios namespaces abre una lista por namespace y las une ([[03 - Algoritmos/Varios Namespaces]]).
**Motivo:** pedir todo el clúster y filtrar exige permisos de clúster que mucha gente no tiene.

## Editor de datos con `resourceVersion`

**Decisión:** ConfigMaps, Secrets, etiquetas y taints se guardan con `GET` + comparación + `PUT` ([[03 - Algoritmos/Edición con Control de Concurrencia]]).
**Motivo:** un cambio concurrente debe dar conflicto, no perderse. Un parche habría pisado claves que otra persona acababa de añadir.

## Helm por su CLI

**Decisión:** ejecutar `helm` con argumentos en lista, sin shell, valores por stdin ([[02 - Acceso al Clúster/Helm]]).
**Motivo:** el formato de release es de Helm; reimplementarlo no aporta. Sin `helm`, solo esa sección queda inactiva.

## Pruebas solo contra un clúster desechable

**Decisión:** las pruebas de extremo a extremo y las capturas exigen el contexto `codycube-test` ([[06 - QA y Tests/Clúster Desechable]]).
**Motivo:** drenan nodos, borran objetos y abren shells: nunca deben poder tocar un clúster real por un `KUBECONFIG` olvidado.
