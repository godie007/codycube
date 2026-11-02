import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { bridge, invoke } from '../lib/api'

export function TerminalPanel({
  contextId,
  namespace,
  pod,
  container,
  active
}: {
  contextId: string
  namespace: string
  pod: string
  container: string
  active: boolean
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const fit = useRef<FitAddon | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const [session, setSession] = useState(0)
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    if (!host.current) return
    const terminal = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0f1216', foreground: '#d9dee5' }
    })
    const addon = new FitAddon()
    terminal.loadAddon(addon)
    terminal.open(host.current)
    fit.current = addon
    terminalRef.current = terminal
    if (host.current.clientWidth > 0) addon.fit()
    setClosed(false)

    let terminalId: string | undefined
    let cancelled = false
    const buffered: string[] = []
    const unsubscribe = bridge.onTerminal((message) => {
      if (message.terminalId !== terminalId) return
      if (message.kind === 'data') terminal.write(message.data)
      else {
        terminal.write(`\r\n\x1b[2m[sesión terminada${message.error ? `: ${message.error}` : ''}]\x1b[0m\r\n`)
        setClosed(true)
      }
    })
    invoke('exec:start', contextId, namespace, pod, container, terminal.cols, terminal.rows).then(
      (id) => {
        if (cancelled) {
          void invoke('exec:stop', id)
          return
        }
        terminalId = id
        for (const data of buffered.splice(0)) void invoke('exec:input', id, data)
      },
      (error: Error) => {
        terminal.write(`\x1b[31m${error.message}\x1b[0m\r\n`)
        setClosed(true)
      }
    )
    const input = terminal.onData((data) => {
      if (terminalId) void invoke('exec:input', terminalId, data)
      else buffered.push(data)
    })
    const resize = terminal.onResize(({ cols, rows }) => {
      if (terminalId) void invoke('exec:resize', terminalId, cols, rows)
    })
    const observer = new ResizeObserver(() => {
      // Oculta mide 0 y el ajuste dejaría la terminal en una columna
      if (host.current && host.current.clientWidth > 0) addon.fit()
    })
    observer.observe(host.current)
    return () => {
      cancelled = true
      observer.disconnect()
      input.dispose()
      resize.dispose()
      unsubscribe()
      if (terminalId) void invoke('exec:stop', terminalId)
      terminal.dispose()
    }
  }, [contextId, namespace, pod, container, session])

  useEffect(() => {
    if (active) {
      fit.current?.fit()
      terminalRef.current?.focus()
    }
  }, [active])

  return (
    <div className="terminal">
      {closed && (
        <button className="btn terminal-retry" onClick={() => setSession((value) => value + 1)}>
          Abrir de nuevo
        </button>
      )}
      <div className="terminal-host" ref={host} data-testid="terminal" />
    </div>
  )
}
