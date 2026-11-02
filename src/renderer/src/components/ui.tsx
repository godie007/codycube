import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Logo } from './Logo'

export interface FieldSpec {
  name: string
  label: string
  type: 'number' | 'text' | 'checkbox' | 'select' | 'textarea'
  value?: string | number | boolean
  options?: { value: string; label: string }[]
  hint?: string
  placeholder?: string
}

export interface DialogSpec {
  title: string
  body?: ReactNode
  confirm?: string
  danger?: boolean
  /** El usuario debe escribir este texto para habilitar la confirmación */
  typeToConfirm?: string
  fields?: FieldSpec[]
}

type Values = Record<string, string | number | boolean>

interface Toast {
  id: number
  tone: 'ok' | 'bad'
  text: string
}

interface UiContextValue {
  ask(spec: DialogSpec): Promise<Values | null>
  toast(text: string, tone?: 'ok' | 'bad'): void
  /** Ejecuta una acción mostrando su error, si lo hay, como aviso */
  run<T>(action: () => Promise<T>, done?: string): Promise<T | undefined>
}

const UiContext = createContext<UiContextValue | null>(null)

export const useUi = (): UiContextValue => {
  const value = useContext(UiContext)
  if (!value) throw new Error('Falta UiProvider')
  return value
}

export function UiProvider({ children }: { children: ReactNode }): ReactNode {
  const [dialog, setDialog] = useState<(DialogSpec & { resolve(values: Values | null): void }) | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const toast = useCallback((text: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = nextId.current++
    setToasts((list) => [...list.slice(-3), { id, tone, text }])
    // Los errores se quedan más tiempo: suelen traer algo que hay que leer
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === 'bad' ? 9000 : 3500)
  }, [])
  const ask = useCallback((spec: DialogSpec) => new Promise<Values | null>((resolve) => setDialog({ ...spec, resolve })), [])
  const run = useCallback(
    async <T,>(action: () => Promise<T>, done?: string): Promise<T | undefined> => {
      try {
        const result = await action()
        if (done) toast(done)
        return result
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'bad')
        return undefined
      }
    },
    [toast]
  )

  return (
    <UiContext.Provider value={{ ask, toast, run }}>
      {children}
      {dialog && (
        <Dialog
          spec={dialog}
          onClose={(values) => {
            dialog.resolve(values)
            setDialog(null)
          }}
        />
      )}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </UiContext.Provider>
  )
}

function Dialog({ spec, onClose }: { spec: DialogSpec; onClose(values: Values | null): void }): ReactNode {
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries((spec.fields ?? []).map((f) => [f.name, f.value ?? (f.type === 'checkbox' ? false : '')]))
  )
  const [typed, setTyped] = useState('')
  const blocked = spec.typeToConfirm !== undefined && typed !== spec.typeToConfirm

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = (name: string, value: string | number | boolean): void => setValues((current) => ({ ...current, [name]: value }))

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-label={spec.title}
        onSubmit={(event) => {
          event.preventDefault()
          if (!blocked) onClose(values)
        }}
      >
        <h2>{spec.title}</h2>
        {spec.body && <div className="dialog-body">{spec.body}</div>}
        {spec.fields?.map((field, index) => (
          <label key={field.name} className={field.type === 'checkbox' ? 'field check' : 'field'}>
            {field.type !== 'checkbox' && <span>{field.label}</span>}
            {field.type === 'checkbox' ? (
              <input type="checkbox" checked={Boolean(values[field.name])} onChange={(e) => set(field.name, e.target.checked)} />
            ) : field.type === 'select' ? (
              <select value={String(values[field.name])} onChange={(e) => set(field.name, e.target.value)}>
                {field.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : field.type === 'textarea' ? (
              <textarea rows={8} placeholder={field.placeholder} value={String(values[field.name])} onChange={(e) => set(field.name, e.target.value)} />
            ) : (
              <input
                autoFocus={index === 0}
                type={field.type}
                min={field.type === 'number' ? 0 : undefined}
                placeholder={field.placeholder}
                value={String(values[field.name])}
                onChange={(e) => set(field.name, field.type === 'number' ? Number(e.target.value) : e.target.value)}
              />
            )}
            {field.type === 'checkbox' && <span>{field.label}</span>}
            {field.hint && <small>{field.hint}</small>}
          </label>
        ))}
        {spec.typeToConfirm !== undefined && (
          <label className="field">
            <span>
              Escribe <code>{spec.typeToConfirm}</code> para confirmar
            </span>
            <input autoFocus aria-label="Confirmación" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => onClose(null)}>
            Cancelar
          </button>
          <button type="submit" className={spec.danger ? 'btn danger' : 'btn primary'} disabled={blocked}>
            {spec.confirm ?? 'Aceptar'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="empty">
      <Logo size={84} />
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  )
}

export function Badge({ tone, children }: { tone?: string; children: ReactNode }): ReactNode {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>
}
