---
title: Seguridad
description: Aislamiento del renderer, dónde viven las credenciales, modo solo lectura y plugins exec
type: arquitectura
tags:
  - arquitectura
  - seguridad
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[01 - Arquitectura/Procesos e IPC]]"
next: "[[01 - Arquitectura/Modelo de Datos]]"
---

# 🔒 Seguridad

Un cliente de Kubernetes maneja credenciales de administración. El diseño parte de que **la interfaz no debe poder hacer nada que no pase por una lista cerrada de operaciones del proceso principal**.

## Renderer aislado

| Medida | Dónde |
|---|---|
| `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` | `createWindow()` en `src/main/index.ts` |
| CSP estricta: `script-src 'self'`, `connect-src 'self'`, `img-src 'self' data:`, `worker-src 'self'` | `index.html` del renderer compilado |
| Navegación bloqueada salvo a la propia app; enlaces externos al navegador del sistema | `will-navigate`, `setWindowOpenHandler` |
| Permisos del navegador (cámara, notificaciones…) denegados | `setPermissionRequestHandler` |
| Origen de cada llamada IPC comprobado | `isOwnFrame` |

La prueba de extremo a extremo `la ventana es segura` verifica que en la página no existen `require` ni `process`, que existe el puente y que la CSP está presente.

## Credenciales

- Los kubeconfig **no se copian**: Codycube recuerda rutas y preferencias (`KubeconfigStore`), nunca su contenido. Un kubeconfig pegado como texto se guarda en la carpeta de datos de la app.
- Solo el proceso principal construye clientes (`clientFor`) y habla con el servidor de API.
- **Plugins `exec`** (gcloud, aws, kubelogin…): un contexto que ejecuta un comando para autenticarse necesita autorización explícita la primera vez (`config:trust-exec`). La confianza se guarda por contexto y comando: si el kubeconfig cambia el comando, se vuelve a pedir.
- Los valores de Helm se pasan por **stdin**: no quedan en disco ni en la línea de comandos.

## Modo solo lectura

```ts
/** El modo solo lectura se aplica aquí, no en la interfaz: ninguna ruta de código puede saltárselo */
function writable(contextId: string): KubeClient {
  if (store.isReadOnly(contextId)) throw new Error('Este clúster está en modo solo lectura')
  return clientFor(contextId)
}
```

Todos los handlers que escriben (editar, aplicar, borrar, escalar, drenar, datos, imagen, taints, Helm…) pasan por `writable`. La terminal cuenta como escritura. La simulación de un `apply` (`dryRun`) sí se permite. Las pruebas `e2e.mjs` y `e2e-admin.mjs` llaman directamente al puente desde la página en modo solo lectura y comprueban que el proceso principal se niega.

## Secrets

- En el panel de detalles y en el editor de datos los valores están **ocultos hasta pedirlos**.
- La anotación `kubectl.kubernetes.io/last-applied-configuration` (que contiene el objeto entero, valores incluidos) no se muestra como etiqueta.
- La sección se titula «en base64: codificados, no cifrados» para no dar una falsa sensación de seguridad.

## Tráfico

La lectura de métricas son peticiones `GET` a `pods/proxy` a través del servidor de API: no abre puertos ni expone nada en la red local. Los reenvíos de puertos escuchan solo en `127.0.0.1`.
