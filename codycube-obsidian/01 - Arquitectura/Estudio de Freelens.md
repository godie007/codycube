---
title: Estudio de Freelens
description: Cómo funciona un cliente tipo Lens (estudiado en Freelens, MIT) y qué decisiones tomó Codycube a partir de ahí
type: arquitectura
tags:
  - arquitectura
  - investigacion
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[01 - Arquitectura/Modelo de Datos]]"
next: "[[02 - Acceso al Clúster/Kubeconfig y Contextos]]"
related:
  - "[[Decisiones]]"
---

## Fuente de este estudio

Lens Desktop es software propietario. Sus términos, incluidos en la propia app
(`Lens.app/Contents/Resources/static/license.md`, cláusula 2.1), dicen: *"You may not (…) reverse
engineer"*. Por eso **no se analizó ni se descompiló `Lens.app`**: solo se leyó ese archivo de licencia.

Se estudió **Freelens v2.0.0** (licencia MIT), fork comunitario de OpenLens, que a su vez es la base
abierta de la que partió Lens:

- Paquete publicado: `Freelens-2.0.0-macos-arm64.dmg`, con checksum verificado. `app.asar` tiene
  SHA-256 `f77376ff4880626638cbcb6d9eea30a94a503713fae1bf2e2591db692cf8fb52`.
- Análisis estático con REA de `static/build/main.js`. Evidencia: `ev_f5f26be503069d80c73438305fc4cc3252df3034599831257e472d2f9d571068`.
- Código fuente del tag `v2.0.0`: `packages/core/src/main/{freelens-proxy,kubeconfig-manager,cluster,shell-session}`.

Codycube no copia código de Freelens: se escribió desde cero y usa una arquitectura distinta.

**Límite de este estudio:** describe a Freelens. Que Lens actual funcione igual es una inferencia por
su origen común, no algo comprobado. El análisis con REA fue estático y parcial (solo el proceso
principal), con los límites de cobertura que indica la evidencia; el comportamiento se tomó del
código fuente.

## Lo observado en Freelens

| Tema | Observación | Origen |
| --- | --- | --- |
| Procesos | 2 `BrowserWindow`, 0 preload, 0 APIs `contextBridge` | REA |
| Aislamiento | `nodeIntegration: true`, `contextIsolation: false`: la interfaz tiene Node | Fuente, `create-electron-window.injectable.ts` |
| Acceso al clúster | Un proxy HTTPS local en el proceso principal (con token y validación de origen) reenvía a un binario `freelens-k8s-proxy` por clúster | Fuente, `freelens-proxy.ts`, `freelens-k8s-proxy-manager.injectable.ts` |
| Herramientas externas | Genera un kubeconfig temporal que apunta al proxy, para kubectl y helm | Fuente, `kubeconfig-manager.ts` |
| Datos en vivo | La interfaz hace list + watch, agrupa eventos y relista tras un error de `resourceVersion` | Fuente, `kube-object.store.ts` |
| Registros | Consulta cada 10 s con `sinceTime`, no usa `follow` | Fuente, `dock/logs/store.ts` |
| Terminal | `node-pty` lanza `kubectl exec` localmente, con xterm en la interfaz | Fuente, `shell-session/` |
| Helm | CLI de `helm` empaquetada | Fuente, `main/helm` |
| Secciones | Una por tipo: cargas, configuración, red, almacenamiento, control de acceso, CRD | Fuente, `*sidebar-item*` |

## Qué decidió Codycube

| Tema | Codycube | Por qué |
| --- | --- | --- |
| Seguridad de la ventana | `sandbox`, `contextIsolation`, sin Node, CSP estricta y validación del remitente en cada IPC | Un XSS con datos del clúster (un log, una anotación) no alcanza ni el sistema ni las credenciales |
| Acceso al clúster | REST directo desde el proceso principal con `@kubernetes/client-node` (solo para autenticar), sin proxy ni binarios | Mucho menos que mantener. Las credenciales nunca llegan a la interfaz |
| Tipos de recursos | Un único camino genérico guiado por el descubrimiento de la API | Lo mismo sirve para pods y para cualquier CRD |
| Registros | `follow=true` real, una conexión por contenedor | Más inmediato que consultar periódicamente |
| Terminal | WebSocket `exec` directo (`v4.channel.k8s.io`) | No requiere `kubectl` local ni el módulo nativo `node-pty` |
| Reenvío de puertos | WebSocket `portforward` directo, escuchando solo en `127.0.0.1` | Sin dependencias externas |
| Helm | CLI de `helm` del sistema, argumentos sin shell, valores por stdin | Reimplementar Helm no aporta. Sin helm, solo esa sección queda inactiva |
| Plugins `exec` del kubeconfig | Se pide autorización del comando concreto antes de ejecutarlo | Un kubeconfig ajeno puede ejecutar cualquier comando |
| Modo solo lectura | Por clúster, aplicado en el proceso principal | No depende de que la interfaz oculte un botón |

**Lo que se pierde frente a Lens:** extensiones, catálogo de charts, gráficas históricas de Prometheus,
terminal local con `kubectl` preconfigurado y shell en nodos. Ver «Aún no incluye» en el README.
