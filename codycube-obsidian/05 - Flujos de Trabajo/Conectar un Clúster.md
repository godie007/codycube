---
title: Conectar un Clúster
description: Paso a paso para cargar un kubeconfig, autorizar plugins exec y abrir el clúster
type: flujo
tags:
  - flujo
  - kubeconfig
updated: 2026-11-02
up: "[[00 - Inicio]]"
next: "[[05 - Flujos de Trabajo/Ver la Comunicación entre Microservicios]]"
related:
  - "[[02 - Acceso al Clúster/Kubeconfig y Contextos]]"
---

# 🔗 Conectar un Clúster

![[bienvenida.png]]

1. **Abre Codycube.** Si existe `$KUBECONFIG` o `~/.kube/config`, sus contextos ya aparecen.
2. **Añade más** con **Cargar kubeconfig**, **Pegar texto** o soltando el archivo sobre la ventana. Codycube recuerda la ruta: si el archivo cambia (por ejemplo, `gcloud container clusters get-credentials`), la lista se actualiza sola.
3. **Autoriza el plugin** si el contexto usa `exec` (GKE, EKS, AKS con kubelogin…). Se muestra el comando exacto; solo se autoriza ese comando para ese contexto.
4. **(Opcional) Activa solo lectura** para un clúster de producción: el proceso principal rechazará cualquier escritura, incluida la terminal.
5. **Abre el contexto.** Se cargan el descubrimiento de tipos y el resumen.

![[resumen.png]]

> [!tip] Si no conecta
> El error dice qué pasó y con qué servidor: «El servidor https://127.0.0.1:16443 rechazó la conexión», «No se encontró el servidor … (DNS)», «Certificado TLS no válido en …». Si la app se abrió desde Finder y no encuentra un comando que sí está en la terminal, revisa que esté en el `PATH` de tu shell de inicio (`~/.zprofile` o `~/.zshrc`).
