---
title: Glosario
description: Términos de Kubernetes, Dapr y Codycube usados en la documentación
type: referencia
tags:
  - glosario
updated: 2026-11-02
up: "[[00 - Inicio]]"
---

# 📖 Glosario

| Término | Significado |
|---|---|
| **Kubeconfig** | Archivo YAML con clústeres, usuarios y contextos. Codycube recuerda su ruta, no su contenido |
| **Contexto** | Combinación de clúster, usuario y namespace por defecto. En Codycube se identifica como `<id de archivo>/<nombre>` |
| **Plugin `exec`** | Comando externo que entrega credenciales (gcloud, aws, kubelogin). Requiere autorización |
| **Descubrimiento** | Consulta de `/api` y `/apis` para saber qué tipos sirve el clúster |
| **CRD** | Definición de un recurso personalizado. Sus objetos aparecen en «Recursos personalizados» |
| **Watch** | Petición larga que envía los cambios de una lista desde una `resourceVersion` |
| **`resourceVersion`** | Versión de un objeto o lista; base de los watch y del control de concurrencia |
| **410 Gone** | La `resourceVersion` pedida ya no está en el historial del servidor: hay que volver a listar |
| **Server-side apply** | El servidor fusiona el manifiesto y registra qué gestor posee cada campo |
| **Desalojo (Eviction)** | Borrado de un pod que respeta los PodDisruptionBudget |
| **PDB** | PodDisruptionBudget: mínimo de pods que deben seguir disponibles durante desalojos |
| **Taint / tolerancia** | Marca de un nodo que repele pods que no la toleran |
| **Acordonar** | Marcar un nodo como no programable (`spec.unschedulable`) |
| **Dapr** | Runtime de microservicios que añade un sidecar a cada app para invocación, pub/sub, estado… |
| **Sidecar (`daprd`)** | Contenedor de Dapr junto a la app; expone métricas en el puerto 9090 |
| **app-id** | Nombre de la app en Dapr (`dapr.io/app-id`) |
| **Componente** | Recurso de Dapr que conecta con un servicio externo: broker pub/sub, almacén de estado, binding… |
| **Tema** | Canal de pub/sub dentro de un broker |
| **Declarado** | Lo que se deduce de los objetos (selector, Ingress, variables, scopes). Línea discontinua |
| **Medido / observado** | Lo que han contado los sidecars. Línea continua |
| **No entregada** | Llamada que Dapr no pudo enviar al destino (p. ej. sin pods); se deduce de los 5xx que el sidecar devuelve a la app |
| **p50 / p95** | Latencia por debajo de la cual queda el 50 % / 95 % de las peticiones |
| **Clúster desechable** | k3s en Docker llamado `codycube-test`, el único donde corren las pruebas |
| **Modo solo lectura** | Preferencia por clúster que hace que el proceso principal rechace toda escritura |
