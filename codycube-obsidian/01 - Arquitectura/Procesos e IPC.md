---
title: Procesos e IPC
description: El canal único codycube:api, su sobre de respuesta y los canales de empuje del proceso principal
type: arquitectura
tags:
  - arquitectura
  - ipc
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[01 - Arquitectura/Stack Tecnológico]]"
next: "[[01 - Arquitectura/Seguridad]]"
---

# 🔌 Procesos e IPC

## Un solo canal de petición

El renderer llama `invoke(método, ...args)`. El preload lo convierte en `ipcRenderer.invoke('codycube:api', método, args)` y el proceso principal busca `handlers[método]` en una **lista cerrada** tipada por `Api` (`src/shared/types.ts`).

```ts
// src/preload/index.ts
invoke: async (method, ...args) => {
  const result = await ipcRenderer.invoke('codycube:api', method, args)
  if (!result.ok) throw new Error(result.error)
  return result.value
}
```

- La respuesta siempre es un sobre `{ ok, value }` o `{ ok: false, error }`. Así el mensaje de error llega limpio: Electron antepone su propio texto a las excepciones que cruzan el IPC.
- Antes de ejecutar, `isOwnFrame` comprueba que la llamada viene de la ventana propia (`file://` o la URL de desarrollo).
- Un método desconocido devuelve error en lugar de lanzar.

## Canales de empuje

| Canal | Emite | Lo consume |
|---|---|---|
| `codycube:watch` | `snapshot`, `events` en lote, `status` (reconectando) y `error` de cada lista en vivo | `useWatch` |
| `codycube:logs` | Lotes de líneas y avisos de fin de flujo | `LogsPanel` |
| `codycube:terminal` | Salida y cierre de cada sesión `exec` | `TerminalPanel` |
| `codycube:forwards` | Lista de reenvíos activos | `ForwardsPage` |
| `codycube:traffic` | Instantáneas de arquitectura y tráfico | `ArchitecturePage` |
| `codycube:config-changed` | Un kubeconfig cambió en disco | lista de clústeres |

Cada flujo tiene un id (`watchId`, `streamId`, `sessionId`) que el renderer guarda para filtrar sus mensajes y para cerrarlo. Si un mensaje llega antes que la respuesta con el id, `useWatch` lo guarda y lo aplica después.

## Ciclo de vida

- Al recargar la ventana (`did-start-loading`) o cerrarla se cortan todas las sesiones: listas, logs, terminales y tráfico. No quedan conexiones huérfanas contra el clúster.
- Los reenvíos de puertos se detienen al salir de la app (`before-quit`).
- Las sesiones de tráfico programan cada lectura con `setTimeout` **después** de terminar la anterior: nunca se solapan.
