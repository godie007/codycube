---
title: Hoja de Ruta
description: Próximos pasos posibles para Codycube, por prioridad
type: plan
tags:
  - roadmap
updated: 2026-11-02
up: "[[00 - Inicio]]"
related:
  - "[[Limitaciones Conocidas]]"
---

# 🗺️ Hoja de Ruta

## Ahora

- [ ] Firma con Developer ID y notarización para distribuir la app fuera de este equipo.
- [ ] Empaquetado para Linux y Windows.
- [ ] Integración continua: typecheck y unitarias en cada push; extremo a extremo con k3s en el runner.

## Después

- [ ] Gráficas históricas de CPU y memoria si el clúster tiene Prometheus.
- [ ] Tráfico de mallas de servicio (Istio, Linkerd) además de Dapr.
- [ ] Shell en nodos mediante un pod privilegiado efímero.
- [ ] Terminal local con un `kubectl` ya apuntando al contexto elegido.
- [ ] Formularios para RBAC: quién puede hacer qué, con simulación de `SelfSubjectAccessReview`.

## Más adelante

- [ ] Catálogo de charts de Helm con búsqueda en repositorios.
- [ ] Comparar el estado de dos namespaces o clústeres.
- [ ] Atajos de teclado y paleta de comandos.
