import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Texto del botón: corto, porque vive en una barra lateral estrecha */
export function namespaceSummary(selected: string[]): string {
  if (selected.length === 0) return 'Todos'
  if (selected.length <= 2) return selected.join(', ')
  return `${selected.length} namespaces`
}

/**
 * Selección de varios namespaces. Vacío significa todos. Cada fila tiene «solo» para el caso más
 * común, cambiar de un namespace a otro, sin tener que desmarcar el anterior.
 */
export function NamespacePicker({ names, selected, onChange }: { names: string[]; selected: string[]; onChange(next: string[]): void }): ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // Lo elegido que ya no existe sigue en la lista: si no, no habría forma de quitarlo
  const all = [...new Set([...names, ...selected])].sort()
  const needle = query.trim().toLowerCase()
  const shown = all.filter((name) => name.toLowerCase().includes(needle))
  const chosen = new Set(selected)
  // Sin permiso para listar namespaces la lista sale vacía: hay que poder escribir el nombre a mano
  const typed = query.trim()
  const canAdd = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(typed) && !all.includes(typed)
  const add = (): void => {
    onChange([...selected, typed].sort())
    setQuery('')
  }
  const toggle = (name: string): void => onChange(chosen.has(name) ? selected.filter((n) => n !== name) : [...selected, name].sort())

  return (
    <div
      className="ns-picker"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
        }
      }}
    >
      <button className="ns-button" aria-label="Filtro de namespaces" aria-haspopup="listbox" aria-expanded={open} title={selected.join(', ') || 'Todos los namespaces'} onClick={() => setOpen(!open)}>
        <span className="ns-value">{namespaceSummary(selected)}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="ns-popover">
          <input
            ref={search}
            className="ns-search"
            aria-label="Buscar namespace"
            placeholder="Buscar namespace"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Intro con un único resultado lo deja como el único elegido
              if (e.key !== 'Enter') return
              if (canAdd) add()
              else if (shown.length === 1) {
                onChange([shown[0]])
                setOpen(false)
              }
            }}
          />
          <div className="ns-list" role="listbox" aria-multiselectable="true" aria-label="Namespaces">
            <label className={`ns-row ns-all ${selected.length === 0 ? 'on' : ''}`}>
              <input type="checkbox" checked={selected.length === 0} onChange={() => onChange([])} />
              <span>Todos los namespaces</span>
            </label>
            {shown.map((name) => (
              <div key={name} className={`ns-row ${chosen.has(name) ? 'on' : ''}`} role="option" aria-selected={chosen.has(name)}>
                <label>
                  <input type="checkbox" checked={chosen.has(name)} onChange={() => toggle(name)} />
                  <span className="ns-name">{name}</span>
                </label>
                <button
                  className="ns-only"
                  aria-label={`Solo ${name}`}
                  onClick={() => {
                    onChange([name])
                    setOpen(false)
                  }}
                >
                  solo
                </button>
              </div>
            ))}
            {canAdd && (
              <button className="ns-row ns-add" onClick={add}>
                + Añadir «{typed}»
              </button>
            )}
            {shown.length === 0 && !canAdd && <div className="ns-empty dim small">Ningún namespace coincide</div>}
            {names.length === 0 && <div className="ns-empty dim small">No se pueden listar los namespaces; escribe el nombre</div>}
          </div>
          <div className="ns-foot dim small">{selected.length === 0 ? 'Se muestran todos' : `${selected.length} elegidos`}</div>
        </div>
      )}
    </div>
  )
}
