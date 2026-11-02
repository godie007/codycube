---
title: Historial de Cambios
description: Hitos de Codycube por versión
type: changelog
tags:
  - changelog
updated: 2026-11-02
up: "[[00 - Inicio]]"
---

# 🕓 Historial de Cambios

## 0.1.0 — 2026-11-02

Primera versión publicada.

### Clústeres y recursos
- Varios kubeconfig y varios clústeres abiertos a la vez; token, certificado o plugin `exec` con autorización.
- Modo solo lectura por clúster, aplicado en el proceso principal.
- Tablas en vivo para cada tipo que sirve el clúster, incluidos los CRD con sus columnas.
- Filtro de varios namespaces (una lista en vivo por namespace).
- Resumen del clúster con consumo real si hay metrics-server.

### Operación
- Registros en vivo por pod o combinados por carga, terminal y reenvío de puertos sin `kubectl`.
- YAML: ver, editar con detección de conflictos, crear, simular y aplicar.
- Escalar, reiniciar, revertir, pausar y reanudar, cambiar imagen; CronJobs; acordonar, drenar y taints.
- Helm: listar, instalar o actualizar, valores, manifiesto, historial, revertir y desinstalar.

### Administración sin YAML
- Editor de ConfigMaps y Secrets por claves, con diff, conflicto, inmutables y binarios intactos.
- Formularios para crear Secrets de cada tipo, incluidas credenciales de registro.
- «Usado por» y reinicio de las cargas afectadas.
- Etiquetas y anotaciones.

### Arquitectura y tráfico
- Diagrama de la arquitectura declarada y del tráfico real medido en los sidecars de Dapr, con tasa, errores, latencias, desglose y detección de destinos caídos.

### Calidad
- 53 pruebas unitarias y cuatro suites de extremo a extremo contra un clúster desechable.
- Distribución probada de 960 × 600 a 1920 × 1080.
- Logo, imagen e icono SVG animados; documentación en Obsidian con capturas reproducibles.
