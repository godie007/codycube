---
title: Helm
description: Releases de Helm a través de la CLI instalada, con el kubeconfig y contexto elegidos
type: acceso
tags:
  - helm
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[02 - Acceso al Clúster/Acciones de Escritura]]"
next: "[[03 - Algoritmos/Topología Declarada]]"
related:
  - "[[05 - Flujos de Trabajo/Releases de Helm]]"
---

# ⎈ Helm

Código: `src/main/helm.ts`.

Helm guarda sus releases en Secrets con su propio formato comprimido. Reimplementarlo no aporta nada: Codycube llama a la CLI `helm` que tenga el equipo.

| Operación | Comando |
|---|---|
| Listar | `helm list --output json --max 0` (en el namespace o en todos) |
| Historial | `helm history <release> --output json` |
| Valores | `helm get values <release> --all --output yaml` |
| Manifiesto | `helm get manifest <release>` |
| Instalar o actualizar | `helm upgrade <release> <chart> --install --create-namespace --namespace <ns> --values -` |
| Revertir | `helm rollback <release> <revisión>` |
| Desinstalar | `helm uninstall <release>` |

Todas añaden `--kubeconfig <ruta> --kube-context <contexto>`: Helm usa exactamente el clúster que se ve en pantalla, nunca el contexto actual de la terminal.

## Seguridad

- `spawn('helm', args)` con la lista de argumentos y **sin shell**: un nombre no puede inyectar comandos. Además, los nombres de release se validan como nombres DNS.
- Los valores viajan por **stdin** (`--values -`): no se escriben en disco ni aparecen en la lista de procesos.
- Si `helm` no está en el `PATH`, solo esa sección queda inactiva con un aviso.

![[helm.png]]
