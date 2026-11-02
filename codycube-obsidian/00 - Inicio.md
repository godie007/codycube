---
title: Codycube — Inicio
description: Punto de entrada (MOC) a la documentación de Codycube; un enlace por nota vigente
type: moc
updated: 2026-11-02
tags:
  - moc
  - codycube
aliases:
  - Inicio
  - Index
  - Home
  - MOC
---

# 🧭 Codycube — Mapa de la documentación

> [!info] ¿Qué es Codycube?
> Cliente **Kubernetes de escritorio** para macOS hecho con **Electron + React + TypeScript**. Carga uno o varios kubeconfig, muestra cada tipo de recurso en vivo (también los CRD), permite administrar el clúster sin YAML (Secrets, ConfigMaps, imágenes, nodos, Helm) y dibuja la **arquitectura y el tráfico real entre microservicios** leyendo los sidecars de Dapr.
> Repositorio: [github.com/godie007/codycube](https://github.com/godie007/codycube).

> [!quote] Convención
> **El código es la fuente de verdad.** Si una nota lo contradice, se corrige la nota y se actualiza su `updated:`. Las rutas citadas son relativas a la raíz del repo (`src/main/traffic.ts`, etc.).

![[arquitectura.png]]

## 🚀 Para empezar

| Si eres… | Empieza por |
|---|---|
| Nuevo en Codycube | [[01 - Arquitectura/Visión General\|Visión General]] · [[04 - Interfaz/Distribución de la Ventana\|Distribución de la ventana]] · [[Glosario]] |
| Desarrollador | [[Desarrollo]] · [[01 - Arquitectura/Stack Tecnológico\|Stack]] · [[01 - Arquitectura/Procesos e IPC\|Procesos e IPC]] · [[02 - Acceso al Clúster/Cliente REST\|Cliente REST]] |
| Quien administra un clúster | [[05 - Flujos de Trabajo/Conectar un Clúster\|Conectar]] · [[05 - Flujos de Trabajo/Editar Secrets y ConfigMaps\|Secrets y ConfigMaps]] · [[05 - Flujos de Trabajo/Desplegar una Nueva Imagen\|Desplegar]] · [[05 - Flujos de Trabajo/Mantenimiento de un Nodo\|Nodos]] |
| Quien opera microservicios | [[05 - Flujos de Trabajo/Ver la Comunicación entre Microservicios\|Ver el tráfico]] · [[05 - Flujos de Trabajo/Depurar un Pod\|Depurar un pod]] |
| QA | [[06 - QA y Tests/Suite de Tests\|Suite de tests]] · [[06 - QA y Tests/Clúster Desechable\|Clúster desechable]] · [[06 - QA y Tests/Capturas\|Capturas]] |

## 🏛️ 01 — Arquitectura

- [[01 - Arquitectura/Visión General|Visión General]] — procesos, capas y recorrido de un dato
- [[01 - Arquitectura/Stack Tecnológico|Stack Tecnológico]] — versiones y por qué cada pieza
- [[01 - Arquitectura/Procesos e IPC|Procesos e IPC]] — el canal `codycube:api` y los canales de empuje
- [[01 - Arquitectura/Seguridad|Seguridad]] — aislamiento, credenciales, solo lectura, plugins `exec`
- [[01 - Arquitectura/Modelo de Datos|Modelo de Datos]] — `ResourceType`, `KubeObject`, topología y tráfico
- [[01 - Arquitectura/Estudio de Freelens|Estudio de Freelens]] — de dónde salió el diseño y qué se hizo distinto

## ☸️ 02 — Acceso al clúster (proceso principal)

- [[02 - Acceso al Clúster/Kubeconfig y Contextos|Kubeconfig y contextos]] — carga, vigilancia de archivos, ids de contexto
- [[02 - Acceso al Clúster/Cliente REST|Cliente REST]] — `KubeClient`, descubrimiento de tipos y errores legibles
- [[02 - Acceso al Clúster/Listas en Vivo|Listas en vivo]] — list + watch, lotes, 410 Gone y reconexión
- [[02 - Acceso al Clúster/Registros, Terminal y Puertos|Registros, terminal y puertos]] — flujos de logs, exec y port-forward
- [[02 - Acceso al Clúster/Acciones de Escritura|Acciones de escritura]] — editar, aplicar, escalar, drenar, datos, imagen, taints
- [[02 - Acceso al Clúster/Helm|Helm]] — la CLI de `helm` con el contexto elegido

## 🧮 03 — Algoritmos

- [[03 - Algoritmos/Topología Declarada|Topología declarada]] — qué se deduce de los objetos
- [[03 - Algoritmos/Tráfico desde Dapr|Tráfico desde Dapr]] — métricas de los sidecars, tasas, errores y latencias
- [[03 - Algoritmos/Disposición del Diagrama|Disposición del diagrama]] — ELK, plegado de Services y filtros
- [[03 - Algoritmos/Varios Namespaces|Varios namespaces]] — una lista por namespace y su unión
- [[03 - Algoritmos/Edición con Control de Concurrencia|Edición con control de concurrencia]] — `resourceVersion` y conflictos

## 🖥️ 04 — Interfaz

- [[04 - Interfaz/Distribución de la Ventana|Distribución de la ventana]]
- [[04 - Interfaz/Arquitectura y Tráfico|Arquitectura y tráfico]]
- [[04 - Interfaz/Tablas y Detalles|Tablas y detalles]]
- [[04 - Interfaz/Editor de Datos|Editor de datos]] — ConfigMaps y Secrets sin YAML
- [[04 - Interfaz/Marca|Marca]] — logo y banner SVG animados

## 🧭 05 — Flujos de trabajo

- [[05 - Flujos de Trabajo/Conectar un Clúster|Conectar un clúster]]
- [[05 - Flujos de Trabajo/Ver la Comunicación entre Microservicios|Ver la comunicación entre microservicios]]
- [[05 - Flujos de Trabajo/Editar Secrets y ConfigMaps|Editar Secrets y ConfigMaps]]
- [[05 - Flujos de Trabajo/Desplegar una Nueva Imagen|Desplegar una nueva imagen]]
- [[05 - Flujos de Trabajo/Mantenimiento de un Nodo|Mantenimiento de un nodo]]
- [[05 - Flujos de Trabajo/Depurar un Pod|Depurar un pod]]
- [[05 - Flujos de Trabajo/Releases de Helm|Releases de Helm]]

## 🧪 06 — QA y tests

- [[06 - QA y Tests/Suite de Tests|Suite de tests]] — unitarias y de extremo a extremo
- [[06 - QA y Tests/Clúster Desechable|Clúster desechable]] — k3s + Dapr en Docker
- [[06 - QA y Tests/Capturas|Capturas]] — cómo se generan las imágenes de esta documentación

## 📎 Transversales

- [[Decisiones]] — registro de decisiones y sus motivos
- [[Desarrollo]] — preparar el entorno, comandos y convenciones
- [[Glosario]]
- [[Limitaciones Conocidas]]
- [[Hoja de Ruta]]
- [[Historial de Cambios]]
