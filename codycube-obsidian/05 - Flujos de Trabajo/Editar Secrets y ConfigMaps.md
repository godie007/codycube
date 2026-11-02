---
title: Editar Secrets y ConfigMaps
description: Cambiar una credencial o una configuración, ver quién la usa y reiniciar las cargas afectadas
type: flujo
tags:
  - flujo
  - secrets
  - configmaps
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[05 - Flujos de Trabajo/Ver la Comunicación entre Microservicios]]"
next: "[[05 - Flujos de Trabajo/Desplegar una Nueva Imagen]]"
related:
  - "[[04 - Interfaz/Editor de Datos]]"
---

# 🔑 Editar Secrets y ConfigMaps

## Cambiar una credencial

1. **Configuración → Secrets**, elige el Secret.
2. En detalles, **Usado por** dice qué cargas lo leen y cómo (variable, volumen, `envFrom`, `imagePullSecrets`).

![[configmap-usado-por.png]]

3. Pulsa **Editar datos**. Los valores aparecen ocultos; pulsa uno para verlo y cambiarlo. También puedes cargar un valor desde un archivo o importar un `.env` entero.

![[secret-editor.png]]

4. **Guardar** muestra qué claves cambian. Si alguien modificó el Secret desde que lo abriste, se te avisa en lugar de pisar su cambio.
5. Se ofrece **reiniciar** las cargas que lo usan. Si lo usan como variables de entorno, reiniciar es necesario: las variables solo se leen al arrancar.

![[secret-guardar.png]]

## Crear credenciales de un registro privado

1. **Secrets → Crear**.
2. Tipo **Credenciales de registro de imágenes**; rellena servidor, usuario y contraseña. Codycube genera el `.dockerconfigjson`.
3. Úsalo en `imagePullSecrets` de la carga.

![[secret-crear.png]]

## Buenas prácticas

- Marca como **inmutable** lo que no deba cambiar (y crea uno nuevo con otro nombre para rotarlo): Kubernetes deja de vigilarlo y nadie lo cambia por error.
- Recuerda que base64 **no es cifrado**: limita quién puede leer Secrets con RBAC.
