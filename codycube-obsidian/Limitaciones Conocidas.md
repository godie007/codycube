---
title: Limitaciones Conocidas
description: Lo que Codycube no hace o hace con matices, y por qué
type: referencia
tags:
  - limitaciones
updated: 2026-11-02
up: "[[00 - Inicio]]"
related:
  - "[[Hoja de Ruta]]"
---

# ⚠️ Limitaciones Conocidas

## Comportamientos a tener en cuenta

- **Aplicar YAML usa server-side apply con `force`**, como `kubectl apply --server-side --force-conflicts`: toma posesión de los campos que indiques aunque otro gestor los controle. Usa **Simular** antes.
- **Editar el YAML de un Secret lo muestra en claro** (en base64), porque abrirlo es pedir verlo. La anotación `last-applied-configuration` se oculta en los detalles pero sí aparece en ese YAML.
- **La terminal cuenta como escritura**: el modo solo lectura la bloquea.
- **Reenvío de puertos de un Service**: apunta a un único pod listo elegido al iniciar, como `kubectl port-forward`. Si ese pod desaparece, hay que iniciarlo de nuevo.
- **Registros**: si un contenedor se reinicia, el flujo termina y aparece **Reanudar**. Se conservan las últimas 50 000 líneas por pestaña.

## Tráfico

- Solo se mide lo que pasa por los sidecars de **Dapr**. La comunicación directa sin Dapr aparece, como mucho, como dependencia declarada. Istio y Linkerd no están soportados.
- Las métricas comprobadas son las de **Dapr 1.19**. Bindings, secretos y configuración usan la misma familia de métricas, pero no se han probado contra un sidecar real.
- Las **No entregadas** requieren que la app hable HTTP con su sidecar y que `increasedCardinality` no esté desactivado.
- Se leen como máximo **200 sidecars** por lectura; si hay más, se avisa.
- El histórico dura lo que la vista esté abierta (60 lecturas): no es Prometheus.

## Aún no incluye

- Extensiones.
- Catálogo de charts de Helm (se instala indicando el chart).
- Gráficas históricas de Prometheus.
- Terminal local con `kubectl` preconfigurado y shell en nodos.
- Edición de RBAC con formularios.
- Firma y notarización de la app: la firma es ad hoc, apta para el equipo donde se genera.
- Empaquetado para Windows o Linux.
