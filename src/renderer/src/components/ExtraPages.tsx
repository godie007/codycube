import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { HelmRelease, HelmRevision, PortForwardInfo } from '../../../shared/types'
import { bridge, invoke } from '../lib/api'
import { Badge, Empty, useUi } from './ui'

export function ForwardsPage({ contextId }: { contextId: string }): ReactNode {
  const [forwards, setForwards] = useState<PortForwardInfo[]>([])
  const { run } = useUi()
  useEffect(() => {
    void invoke('forward:list').then(setForwards)
    return bridge.onForwards(setForwards)
  }, [])
  const mine = forwards.filter((f) => f.contextId === contextId)
  return (
    <section className="table-page">
      <header className="toolbar">
        <h1>Reenvío de puertos</h1>
        <span className="count">{mine.length}</span>
      </header>
      {mine.length === 0 ? (
        <Empty title="Sin reenvíos activos">Ábrelos desde los detalles de un Pod o un Service.</Empty>
      ) : (
        <div className="plain-table">
          <table className="mini wide">
            <thead>
              <tr><th>Recurso</th><th>Namespace</th><th>Pod</th><th>Remoto</th><th>Local</th><th>Conexiones</th><th /></tr>
            </thead>
            <tbody>
              {mine.map((f) => (
                <tr key={f.id}>
                  <td className="name">{f.resourceKind}/{f.resourceName}</td>
                  <td>{f.namespace}</td>
                  <td>{f.targetPod}</td>
                  <td>{f.remotePort}</td>
                  <td data-testid="forward-local"><code>127.0.0.1:{f.localPort}</code></td>
                  <td>{f.connections}</td>
                  <td className="right">
                    <button className="link" onClick={() => void run(() => invoke('forward:open', f.id))}>Abrir</button>{' '}
                    <button className="link" onClick={() => void run(() => invoke('forward:stop', f.id))}>Detener</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function HelmPage({ contextId, namespaces, readOnly }: { contextId: string; namespaces: string[]; readOnly: boolean }): ReactNode {
  const namespaceKey = namespaces.join()
  const [version, setVersion] = useState<string | null | undefined>(undefined)
  const [releases, setReleases] = useState<HelmRelease[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<HelmRelease | null>(null)
  const [history, setHistory] = useState<HelmRevision[]>([])
  const [view, setView] = useState<{ title: string; text: string } | null>(null)
  const { ask, run } = useUi()

  const load = useCallback(async () => {
    try {
      const lists = namespaceKey ? await Promise.all(namespaceKey.split(',').map((ns) => invoke('helm:list', contextId, ns))) : [await invoke('helm:list', contextId, undefined)]
      setReleases(lists.flat())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [contextId, namespaceKey])

  useEffect(() => {
    void invoke('helm:available').then((v) => {
      setVersion(v)
      if (v) void load()
    })
  }, [load])

  useEffect(() => {
    setHistory([])
    setView(null)
    if (selected) void run(() => invoke('helm:history', contextId, selected.namespace, selected.name)).then((h) => setHistory(h ?? []))
  }, [selected, contextId, run])

  const install = async (): Promise<void> => {
    const answer = await ask({
      title: 'Instalar o actualizar release',
      confirm: 'Instalar',
      fields: [
        { name: 'name', label: 'Nombre de la release', type: 'text', placeholder: 'mi-release' },
        { name: 'namespace', label: 'Namespace', type: 'text', value: namespaces.length === 1 ? namespaces[0] : 'default' },
        { name: 'chart', label: 'Chart', type: 'text', placeholder: 'oci://registry-1.docker.io/bitnamicharts/nginx' },
        { name: 'values', label: 'Valores (YAML, opcional)', type: 'textarea' }
      ]
    })
    if (!answer) return
    await run(() => invoke('helm:install', contextId, String(answer.namespace), String(answer.name), String(answer.chart), String(answer.values)), `Release ${answer.name} instalada`)
    await load()
  }

  const uninstall = async (release: HelmRelease): Promise<void> => {
    const answer = await ask({ title: `Desinstalar ${release.name}`, danger: true, confirm: 'Desinstalar', typeToConfirm: release.name, body: 'Elimina todos los objetos de la release.' })
    if (!answer) return
    await run(() => invoke('helm:uninstall', contextId, release.namespace, release.name), `${release.name} desinstalada`)
    setSelected(null)
    await load()
  }

  const rollback = async (release: HelmRelease, revision: number): Promise<void> => {
    const answer = await ask({ title: `Revertir ${release.name} a la revisión ${revision}`, confirm: 'Revertir' })
    if (!answer) return
    await run(() => invoke('helm:rollback', contextId, release.namespace, release.name, revision), `${release.name} revertida`)
    await load()
    setHistory((await invoke('helm:history', contextId, release.namespace, release.name)) ?? [])
  }

  if (version === undefined) return <section className="table-page"><Empty title="Buscando helm…" /></section>
  if (version === null) {
    return (
      <section className="table-page">
        <header className="toolbar"><h1>Helm</h1></header>
        <Empty title="Helm no está instalado">Codycube usa la CLI de Helm. Instálala con <code>brew install helm</code> y vuelve a abrir esta sección.</Empty>
      </section>
    )
  }

  return (
    <section className="table-page">
      <header className="toolbar">
        <h1>Helm</h1>
        <span className="count">{releases.length} · {version}</span>
        <div className="spacer" />
        <button className="btn" onClick={() => void load()}>Actualizar</button>
        <button className="btn primary" disabled={readOnly} onClick={() => void install()}>Instalar</button>
      </header>
      {error ? <Empty title="No se pudo listar">{error}</Empty> : releases.length === 0 ? <Empty title="No hay releases" /> : (
        <div className="plain-table">
          <table className="mini wide">
            <thead>
              <tr><th>Nombre</th><th>Namespace</th><th>Chart</th><th>Versión app</th><th>Rev.</th><th>Estado</th></tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={`${r.namespace}/${r.name}`} className={selected?.name === r.name && selected.namespace === r.namespace ? 'selected' : ''} onClick={() => setSelected(r)}>
                  <td className="name">{r.name}</td>
                  <td>{r.namespace}</td>
                  <td>{r.chart}</td>
                  <td>{r.app_version}</td>
                  <td>{r.revision}</td>
                  <td><Badge tone={r.status === 'deployed' ? 'ok' : 'warn'}>{r.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
          {selected && (
            <div className="helm-detail">
              <div className="toolbar">
                <h2>{selected.name}</h2>
                <button className="btn" onClick={() => void run(() => invoke('helm:values', contextId, selected.namespace, selected.name)).then((text) => text !== undefined && setView({ title: 'Valores', text }))}>Valores</button>
                <button className="btn" onClick={() => void run(() => invoke('helm:manifest', contextId, selected.namespace, selected.name)).then((text) => text !== undefined && setView({ title: 'Manifiesto', text }))}>Manifiesto</button>
                <div className="spacer" />
                <button className="btn danger" disabled={readOnly} onClick={() => void uninstall(selected)}>Desinstalar</button>
              </div>
              <table className="mini wide">
                <thead><tr><th>Revisión</th><th>Chart</th><th>Estado</th><th>Descripción</th><th /></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.revision}>
                      <td>{h.revision}</td>
                      <td>{h.chart}</td>
                      <td>{h.status}</td>
                      <td>{h.description}</td>
                      <td className="right">
                        {h.status !== 'deployed' && <button className="link" disabled={readOnly} onClick={() => void rollback(selected, h.revision)}>Revertir</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view && (
                <>
                  <h3>{view.title}</h3>
                  <pre className="code-view">{view.text || '(vacío)'}</pre>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
