import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ClusterContext, ClusterInfo, KubeconfigFileInfo } from '../../shared/types'
import { ClusterView } from './components/ClusterView'
import { Badge, Empty, useUi } from './components/ui'
import { bridge, invoke } from './lib/api'
import { Hero, Logo } from './components/Logo'

interface OpenCluster {
  context: ClusterContext
  info: ClusterInfo
}

const initials = (name: string): string => {
  const parts = name.replace(/^(gke_|arn:aws:eks:)/, '').split(/[-_/:.]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
}

function hueOf(name: string): number {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}

export function App(): ReactNode {
  const [files, setFiles] = useState<KubeconfigFileInfo[]>([])
  const [contexts, setContexts] = useState<ClusterContext[]>([])
  const [open, setOpen] = useState<OpenCluster[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<{ id: string; message: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const { ask, run } = useUi()

  const apply = useCallback((state: { files: KubeconfigFileInfo[]; contexts: ClusterContext[] } | null | undefined) => {
    if (!state) return
    setFiles(state.files)
    setContexts(state.contexts)
  }, [])

  const reload = useCallback(() => void invoke('config:list').then(apply), [apply])

  useEffect(() => {
    reload()
    return bridge.onConfigChanged(reload)
  }, [reload])

  const connect = async (context: ClusterContext): Promise<void> => {
    if (open.some((c) => c.context.id === context.id)) {
      setActive(context.id)
      return
    }
    if (!context.execTrusted) {
      // Un kubeconfig puede ejecutar cualquier comando al autenticarse: uno ajeno podría ser malicioso
      const answer = await ask({
        title: 'Autorizar comando del kubeconfig',
        confirm: 'Permitir y conectar',
        body: (
          <>
            <p>Para autenticarse, el contexto <strong>{context.name}</strong> ejecutará este comando en tu equipo:</p>
            <pre>{context.execCommand}</pre>
            <p className="dim small">Acéptalo solo si confías en el origen de <code>{context.filePath}</code>.</p>
          </>
        )
      })
      if (!answer) return
      await invoke('config:trust-exec', context.id)
    }
    setConnecting(context.id)
    setConnectError(null)
    try {
      const info = await invoke('cluster:connect', context.id)
      setOpen((current) => [...current, { context, info }])
      setActive(context.id)
    } catch (error) {
      setConnectError({ id: context.id, message: (error as Error).message })
    } finally {
      setConnecting(null)
      reload()
    }
  }

  const disconnect = (id: string): void => {
    void invoke('cluster:disconnect', id)
    setOpen((current) => current.filter((c) => c.context.id !== id))
    setActive((current) => (current === id ? null : current))
  }

  const addText = async (): Promise<void> => {
    const answer = await ask({
      title: 'Pegar kubeconfig',
      confirm: 'Cargar',
      body: 'Se guarda una copia en los datos de Codycube, legible solo por tu usuario.',
      fields: [{ name: 'text', label: 'Contenido YAML', type: 'textarea', placeholder: 'apiVersion: v1\nkind: Config\n…' }]
    })
    if (answer) apply(await run(() => invoke('config:add-text', String(answer.text)), 'Kubeconfig cargado'))
  }

  const removeFile = async (file: KubeconfigFileInfo): Promise<void> => {
    const answer = await ask({
      title: 'Quitar kubeconfig',
      confirm: 'Quitar',
      body: file.managed ? 'Deja de aparecer en Codycube.' : `Deja de aparecer en Codycube. El archivo ${file.path} no se modifica.`
    })
    if (!answer) return
    for (const cluster of open) if (cluster.context.fileId === file.id) disconnect(cluster.context.id)
    apply(await run(() => invoke('config:remove', file.id)))
  }

  const onDrop = async (event: React.DragEvent): Promise<void> => {
    event.preventDefault()
    setDragging(false)
    for (const file of event.dataTransfer.files) {
      apply(await run(() => invoke('config:add-path', bridge.pathForFile(file)), `${file.name} cargado`))
    }
  }

  return (
    <div className="app" onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={(e) => { if (e.relatedTarget === null) setDragging(false) }} onDrop={(e) => void onDrop(e)}>
      <div className="titlebar" />
      <nav className="hotbar" aria-label="Clústeres abiertos">
        <button className={`hot hot-logo ${active === null ? 'active' : ''}`} aria-label="Clústeres" title="Clústeres" onClick={() => setActive(null)}>
          <Logo size={46} />
        </button>
        {open.map(({ context }) => (
          <div key={context.id} className="hot-wrap">
            <button
              className={`hot cluster-icon ${active === context.id ? 'active' : ''}`}
              style={{ background: `hsl(${hueOf(context.name)} 45% 34%)` }}
              aria-label={context.name}
              title={context.name}
              onClick={() => setActive(context.id)}
            >
              {initials(context.name)}
            </button>
            <button className="hot-close" aria-label={`Desconectar ${context.name}`} title="Desconectar" onClick={() => disconnect(context.id)}>✕</button>
          </div>
        ))}
      </nav>

      <div className="stage">
        {active === null && (
          <div className="home">
            <Hero className="home-hero" />
            <header className="home-head">
              <Logo size={64} className="home-logo" />
              <div>
                <div className="home-brand">Codycube</div>
                <h1>Clústeres</h1>
                <p className="dim">Carga uno o varios kubeconfig. Codycube los lee sin modificarlos.</p>
              </div>
              <div className="spacer" />
              <button className="btn" onClick={() => void addText()}>Pegar texto</button>
              <button className="btn primary" onClick={() => void run(() => invoke('config:pick')).then(apply)}>Cargar kubeconfig</button>
            </header>
            {files.length === 0 ? (
              <Empty title="Aún no hay kubeconfig cargados">Pulsa «Cargar kubeconfig» o suelta aquí el archivo.</Empty>
            ) : (
              files.map((file) => (
                <section key={file.id} className="config-file">
                  <header>
                    <code title={file.path}>{file.managed ? 'Pegado en Codycube' : file.path}</code>
                    <div className="spacer" />
                    <button className="link" onClick={() => void removeFile(file)}>Quitar</button>
                  </header>
                  {file.error && <div className="file-error">No se pudo leer: {file.error}</div>}
                  <div className="context-list">
                    {contexts.filter((c) => c.fileId === file.id).map((context) => {
                      const isOpen = open.some((c) => c.context.id === context.id)
                      const failed = connectError?.id === context.id ? connectError.message : null
                      return (
                        <article key={context.id} className="context">
                          <span className="cluster-icon static" style={{ background: `hsl(${hueOf(context.name)} 45% 34%)` }}>{initials(context.name)}</span>
                          <div className="context-text">
                            <div className="context-name">
                              {context.name}
                              {context.isCurrent && <Badge>actual</Badge>}
                              {context.readOnly && <Badge tone="warn">solo lectura</Badge>}
                              {context.execCommand && <Badge tone={context.execTrusted ? undefined : 'warn'}>exec: {context.execCommand.split('/').pop()}</Badge>}
                            </div>
                            <div className="dim small">{context.server} · usuario {context.user}{context.namespace ? ` · ${context.namespace}` : ''}</div>
                            {failed && <div className="context-error">{failed}</div>}
                          </div>
                          <button className={isOpen ? 'btn' : 'btn primary'} disabled={connecting !== null} onClick={() => void connect(context)}>
                            {connecting === context.id ? 'Conectando…' : isOpen ? 'Abrir' : 'Conectar'}
                          </button>
                        </article>
                      )
                    })}
                  </div>
                </section>
              ))
            )}
          </div>
        )}
        {open.map(({ context, info }) => (
          <ClusterView key={context.id} context={context} info={info} visible={active === context.id} />
        ))}
      </div>
      {dragging && <div className="drop-hint">Suelta el kubeconfig para cargarlo</div>}
    </div>
  )
}
