import type { ReactNode } from 'react'
import heroUrl from '../assets/cluster-hero.svg?url'
import logoUrl from '../assets/cluster-logo.svg?url'

// Las animaciones viven dentro de los SVG. Como <img> no ejecutan código, quedan aisladas del resto de
// la app, y el navegador las detiene solo cuando no se ven. Los SVG se generan con scripts/brand.mjs.

/** El clúster moviendo bits. Decorativo: quien lo use pone su propia etiqueta accesible */
export function Logo({ size, className }: { size: number; className?: string }): ReactNode {
  return <img className={`logo ${className ?? ''}`} src={logoUrl} width={size} height={size} alt="" draggable={false} />
}

/** La imagen panorámica del clúster en su sala */
export function Hero({ className }: { className?: string }): ReactNode {
  return <img className={`hero ${className ?? ''}`} src={heroUrl} alt="" draggable={false} />
}
