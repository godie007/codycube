---
title: Releases de Helm
description: Ver, instalar, actualizar, revertir y desinstalar releases de Helm
type: flujo
tags:
  - flujo
  - helm
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[05 - Flujos de Trabajo/Depurar un Pod]]"
next: "[[06 - QA y Tests/Suite de Tests]]"
related:
  - "[[02 - Acceso al Clúster/Helm]]"
---

# ⎈ Releases de Helm

Requiere la CLI `helm` en el `PATH`.

![[helm.png]]

1. **Helm → Releases** lista las releases de los namespaces elegidos con su chart, versión de app, revisión y estado.
2. Elige una para ver sus **valores**, su **manifiesto** y su **historial**.
3. **Instalar o actualizar**: nombre, namespace, chart (`repo/chart`, una URL o una ruta local) y valores en YAML. Equivale a `helm upgrade --install --create-namespace`.
4. **Revertir** a una revisión del historial.
5. **Desinstalar** pide confirmación.

> [!note] Siempre el clúster que ves
> Codycube pasa `--kubeconfig` y `--kube-context` en cada llamada: Helm nunca usa el contexto activo de tu terminal por accidente.
