import { yaml as yamlLanguage } from '@codemirror/lang-yaml'
import { EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, basicSetup } from 'codemirror'
import yaml from 'js-yaml'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { KubeObject, ResourceType } from '../../../shared/types'
import { invoke } from '../lib/api'
import { TEMPLATES } from '../lib/templates'
import { useUi } from './ui'

function useEditor(host: React.RefObject<HTMLDivElement | null>, readOnly: boolean): React.RefObject<EditorView | null> {
  const view = useRef<EditorView | null>(null)
  useEffect(() => {
    if (!host.current) return
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        extensions: [basicSetup, yamlLanguage(), oneDark, EditorState.readOnly.of(readOnly), EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12.5px' } })]
      })
    })
    return () => {
      view.current?.destroy()
      view.current = null
    }
  }, [host, readOnly])
  return view
}

const setText = (view: EditorView | null, text: string): void => {
  view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
}

/** Edita un objeto existente. Guarda con PUT: un cambio concurrente da conflicto y no se pierde */
export function EditPanel({
  contextId,
  object,
  resource,
  readOnly
}: {
  contextId: string
  object: KubeObject
  resource: ResourceType
  readOnly: boolean
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const view = useEditor(host, readOnly)
  const { run } = useUi()
  const { name, namespace } = object.metadata
  const ref = { resource, namespace, name }

  const load = async (): Promise<void> => {
    const latest = await run(() => invoke('resource:get', contextId, ref))
    if (latest) setText(view.current, yaml.dump(latest, { lineWidth: -1, noRefs: true }))
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, contextId, name, namespace, resource.plural])

  const save = async (): Promise<void> => {
    const updated = await run(() => invoke('resource:update', contextId, ref, view.current!.state.doc.toString()), `${name} guardado`)
    if (updated) await load()
  }

  return (
    <div className="yaml">
      <div className="logs-bar">
        <span className="dim small">{readOnly ? 'Solo lectura' : 'Si otra persona cambió el objeto, guardar dará conflicto: recarga y vuelve a aplicar tu cambio.'}</span>
        <div className="spacer" />
        <button className="btn" onClick={() => void load()}>Recargar</button>
        <button className="btn primary" disabled={readOnly} onClick={() => void save()}>Guardar</button>
      </div>
      <div className="editor" ref={host} data-testid="yaml-editor" />
    </div>
  )
}

/** Crea o actualiza objetos a partir de YAML, con simulación en el servidor antes de aplicar */
export function ApplyPanel({
  contextId,
  namespace,
  initialTemplate,
  readOnly
}: {
  contextId: string
  namespace?: string
  initialTemplate?: string
  readOnly: boolean
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const view = useEditor(host, false)
  const { run, toast } = useUi()
  const [template, setTemplate] = useState(initialTemplate && TEMPLATES[initialTemplate] ? initialTemplate : 'Deployment')

  useEffect(() => {
    setText(view.current, TEMPLATES[template].replaceAll('__NAMESPACE__', namespace ?? 'default'))
  }, [view, template, namespace])

  const submit = async (dryRun: boolean): Promise<void> => {
    const results = await run(() => invoke('resource:apply', contextId, view.current!.state.doc.toString(), namespace, dryRun))
    if (results) {
      const names = results.map((r) => `${r.kind}/${r.name}`).join(', ')
      toast(dryRun ? `Simulación correcta: ${names}` : `Aplicado: ${names}`)
    }
  }

  return (
    <div className="yaml">
      <div className="logs-bar">
        <select aria-label="Plantilla" value={template} onChange={(e) => setTemplate(e.target.value)}>
          {Object.keys(TEMPLATES).map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <span className="dim small">Admite varios documentos separados por <code>---</code></span>
        <div className="spacer" />
        <button className="btn" onClick={() => void submit(true)}>Simular</button>
        <button className="btn primary" disabled={readOnly} onClick={() => void submit(false)}>Aplicar</button>
      </div>
      <div className="editor" ref={host} data-testid="yaml-editor" />
    </div>
  )
}
