---
title: Editor de Datos
description: DataPanel — editar y crear ConfigMaps y Secrets por claves, sin YAML ni base64
type: interfaz
tags:
  - interfaz
  - secrets
  - configmaps
updated: 2026-11-02
up: "[[00 - Inicio]]"
prev: "[[04 - Interfaz/Tablas y Detalles]]"
next: "[[04 - Interfaz/Marca]]"
related:
  - "[[05 - Flujos de Trabajo/Editar Secrets y ConfigMaps]]"
  - "[[03 - Algoritmos/Edición con Control de Concurrencia]]"
---

# 🔑 Editor de Datos

Código: `src/renderer/src/components/DataPanel.tsx` y la lógica pura de `src/renderer/src/lib/config-data.ts` (con pruebas en `tests/config-data.test.ts`).

![[secret-editor.png]]

## Modo edición

| Elemento | Comportamiento |
|---|---|
| Filas | Clave + valor multilínea. Las filas cambiadas se marcan |
| Secrets | Los valores se muestran **descodificados**, ocultos hasta pulsar sobre ellos; se guardan en base64 |
| Binarios | `binaryData` de un ConfigMap, o un valor de Secret que no es texto, se conserva intacto: se puede sustituir desde archivo, no editar como texto |
| Barra | Filtrar claves, recuento y tamaño total, **Añadir clave**, **Desde archivo** (≤ 1 MiB), **Importar .env**, **Recargar**, **Guardar** |
| Validación | Claves vacías, repetidas o con caracteres no válidos desactivan Guardar y explican el motivo |
| Inmutable | Se puede ver, no editar: aviso para crear uno nuevo con otro nombre |
| Solo lectura | Igual: aviso y Guardar desactivado |

## Guardar

1. Muestra el **diff por claves**: añadidas, cambiadas y eliminadas. Solo nombres de claves, nunca valores.
2. Guarda con la `resourceVersion` que se abrió: si alguien lo cambió, da conflicto. Ver [[03 - Algoritmos/Edición con Control de Concurrencia|concurrencia]].
3. Si alguna carga lo usa, ofrece **reiniciarla**. Viene marcado si lo usa como variables de entorno (solo se leen al arrancar); los volúmenes se actualizan solos en un minuto salvo con `subPath`.

![[secret-guardar.png]]

## Modo creación

Nombre, namespace y, en Secrets, el tipo:

| Tipo | Claves que exige |
|---|---|
| Genérico (`Opaque`) | — |
| Credenciales de registro (`kubernetes.io/dockerconfigjson`) | Formulario de servidor, usuario, contraseña y email; genera `.dockerconfigjson` |
| Certificado TLS (`kubernetes.io/tls`) | `tls.crt`, `tls.key` |
| Usuario y contraseña (`kubernetes.io/basic-auth`) | `username`, `password` |
| Clave SSH (`kubernetes.io/ssh-auth`) | `ssh-privatekey` |

Casilla **Inmutable** y botón **Usar YAML** para pasar al editor YAML con una plantilla.

![[secret-crear.png]]

## Detalles de implementación

- `touched`: la primera carga no sobrescribe lo que la persona ya escribió.
- Al recargar, cada fila conserva su id por clave: un cambio en curso no se pierde.
- `parseEnv` admite comentarios, `export`, comillas simples y dobles y escapes `\n`.
