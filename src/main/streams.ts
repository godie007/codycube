import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import type WebSocket from 'ws'
import type {
  KubeObject,
  LogLine,
  LogMessage,
  LogOptions,
  PortForwardInfo,
  ResourceType,
  TerminalMessage
} from '../shared/types'
import { labelSelector } from './actions'
import { type KubeClient, resourcePath } from './kube-client'
import { lineSplitter } from './watch'

const POD: ResourceType = {
  group: '',
  version: 'v1',
  plural: 'pods',
  kind: 'Pod',
  namespaced: true,
  verbs: [],
  shortNames: [],
  scalable: false
}
const SERVICE: ResourceType = { ...POD, plural: 'services', kind: 'Service' }

/** Separa la marca de tiempo que antepone el servidor al pedir `timestamps=true` */
export function parseLogLine(pod: string, container: string, raw: string): LogLine {
  const space = raw.indexOf(' ')
  const candidate = space > 0 ? raw.slice(0, space) : raw
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-][\d:]+)$/.test(candidate)) {
    return { pod, container, time: candidate, text: space > 0 ? raw.slice(space + 1) : '' }
  }
  return { pod, container, text: raw }
}

/**
 * Registros de uno o varios contenedores en vivo. Cada fuente es una petición `follow` propia y las
 * líneas se envían en lotes. Devuelve la función que corta todo.
 */
export function streamLogs(
  client: KubeClient,
  options: LogOptions,
  streamId: string,
  send: (message: LogMessage) => void
): () => void {
  const controller = new AbortController()
  let pending: LogLine[] = []
  let timer: NodeJS.Timeout | undefined
  const flush = (): void => {
    timer = undefined
    if (pending.length === 0 || controller.signal.aborted) return
    send({ streamId, kind: 'lines', lines: pending })
    pending = []
  }
  for (const { name, containers } of options.pods) {
    for (const container of containers) {
      const source = `${name}/${container}`
      const splitter = lineSplitter((line) => {
        pending.push(parseLogLine(name, container, line.replace(/\r$/, '')))
        timer ??= setTimeout(flush, 100)
      })
      client
        .stream(
          resourcePath(POD, options.namespace, name, 'log'),
          {
            query: {
              container,
              follow: !options.previous,
              timestamps: true,
              tailLines: options.tailLines,
              previous: options.previous || undefined,
              sinceSeconds: options.sinceSeconds
            },
            signal: controller.signal
          },
          (chunk) => splitter.push(chunk)
        )
        .then(() => {
          flush()
          send({ streamId, kind: 'end', source })
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted) send({ streamId, kind: 'end', source, error: error.message })
        })
    }
  }
  return () => {
    controller.abort()
    if (timer) clearTimeout(timer)
  }
}

const SHELL = 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'

/** Canales del protocolo `v4.channel.k8s.io`: el primer byte de cada mensaje indica el flujo */
const enum Channel {
  Stdin = 0,
  Stdout = 1,
  Stderr = 2,
  Status = 3,
  Resize = 4
}

export interface TerminalSession {
  input(data: string): void
  resize(cols: number, rows: number): void
  stop(): void
}

export async function startTerminal(
  client: KubeClient,
  namespace: string,
  pod: string,
  container: string,
  cols: number,
  rows: number,
  terminalId: string,
  send: (message: TerminalMessage) => void
): Promise<TerminalSession> {
  const socket = await client.webSocket(
    resourcePath(POD, namespace, pod, 'exec'),
    { container, stdin: true, stdout: true, stderr: true, tty: true, command: ['/bin/sh', '-c', SHELL] },
    ['v4.channel.k8s.io']
  )
  const decoders = { [Channel.Stdout]: new StringDecoder('utf8'), [Channel.Stderr]: new StringDecoder('utf8') }
  let status: string | undefined
  let ended = false
  const end = (error?: string): void => {
    if (ended) return
    ended = true
    send({ terminalId, kind: 'exit', error })
  }
  const resize = (width: number, height: number): void => {
    if (socket.readyState !== socket.OPEN) return
    socket.send(Buffer.concat([Buffer.from([Channel.Resize]), Buffer.from(JSON.stringify({ Width: width, Height: height }))]))
  }
  socket.on('open', () => resize(cols, rows))
  socket.on('message', (raw: WebSocket.RawData) => {
    const data = raw as Buffer
    const channel = data[0]
    const body = data.subarray(1)
    if (channel === Channel.Stdout || channel === Channel.Stderr) {
      send({ terminalId, kind: 'data', data: decoders[channel].write(body) })
    } else if (channel === Channel.Status) {
      status = body.toString('utf8')
    }
  })
  socket.on('error', (error: Error) => end(error.message))
  socket.on('close', () => {
    let error: string | undefined
    try {
      const parsed = status ? JSON.parse(status) : undefined
      if (parsed && parsed.status !== 'Success') error = parsed.message
    } catch {
      error = status
    }
    end(error)
  })
  return {
    input(text) {
      if (socket.readyState === socket.OPEN) socket.send(Buffer.concat([Buffer.from([Channel.Stdin]), Buffer.from(text)]))
    },
    resize,
    stop() {
      ended = true
      socket.close()
    }
  }
}

export function isPodReady(pod: KubeObject): boolean {
  return (
    pod.status?.phase === 'Running' &&
    (pod.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === 'Ready' && c.status === 'True')
  )
}

/** Puerto del contenedor al que apunta un `targetPort`, que puede ser un número o un nombre */
export function resolveTargetPort(service: KubeObject, pod: KubeObject, servicePort: number): number {
  const port = (service.spec?.ports ?? []).find((p: { port: number }) => p.port === servicePort)
  if (!port) throw new Error(`El servicio no expone el puerto ${servicePort}`)
  const target = port.targetPort ?? port.port
  if (typeof target === 'number') return target
  for (const container of pod.spec?.containers ?? []) {
    for (const candidate of container.ports ?? []) {
      if (candidate.name === target) return candidate.containerPort
    }
  }
  throw new Error(`Ningún contenedor define el puerto «${target}»`)
}

interface Forward {
  info: PortForwardInfo
  server: net.Server
  sockets: Set<net.Socket>
}

/** Reenvíos activos. Escuchan solo en loopback: nunca se exponen a la red local */
export class PortForwards {
  private forwards = new Map<string, Forward>()

  constructor(private readonly changed: (list: PortForwardInfo[]) => void) {}

  list(): PortForwardInfo[] {
    return [...this.forwards.values()].map((forward) => forward.info)
  }

  get(id: string): PortForwardInfo | undefined {
    return this.forwards.get(id)?.info
  }

  private notify(): void {
    this.changed(this.list())
  }

  async start(
    client: KubeClient,
    contextId: string,
    namespace: string,
    kind: 'Pod' | 'Service',
    name: string,
    remotePort: number,
    localPort: number
  ): Promise<PortForwardInfo> {
    let targetPod = name
    let targetPort = remotePort
    if (kind === 'Service') {
      const service = await client.json<KubeObject>(resourcePath(SERVICE, namespace, name))
      const selector = labelSelector(service.spec?.selector)
      if (!selector) throw new Error('El servicio no tiene selector: no hay pods a los que reenviar')
      const pods = await client.json<{ items: KubeObject[] }>(resourcePath(POD, namespace), {
        query: { labelSelector: selector }
      })
      const pod = pods.items.find(isPodReady)
      if (!pod) throw new Error('El servicio no tiene pods listos')
      targetPod = pod.metadata.name
      targetPort = resolveTargetPort(service, pod, remotePort)
    }
    const id = randomUUID()
    const sockets = new Set<net.Socket>()
    const info: PortForwardInfo = {
      id,
      contextId,
      namespace,
      resourceKind: kind,
      resourceName: name,
      targetPod,
      remotePort,
      localPort,
      connections: 0
    }
    const server = net.createServer((socket) => {
      sockets.add(socket)
      info.connections++
      this.notify()
      socket.on('close', () => {
        sockets.delete(socket)
        info.connections--
        this.notify()
      })
      socket.on('error', () => socket.destroy())
      void this.pipe(client, namespace, targetPod, targetPort, socket)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        reject(error.code === 'EADDRINUSE' ? new Error(`El puerto local ${localPort} ya está en uso`) : error)
      )
      server.listen(localPort, '127.0.0.1', resolve)
    })
    info.localPort = (server.address() as net.AddressInfo).port
    this.forwards.set(id, { info, server, sockets })
    this.notify()
    return info
  }

  /**
   * Una conexión TCP local equivale a un WebSocket `portforward`. Canal 0 lleva datos y canal 1
   * errores, y el primer mensaje de cada canal es solo el número de puerto (2 bytes).
   */
  private async pipe(client: KubeClient, namespace: string, pod: string, port: number, socket: net.Socket): Promise<void> {
    let ws: WebSocket
    try {
      ws = await client.webSocket(resourcePath(POD, namespace, pod, 'portforward'), { ports: String(port) }, [
        'v4.channel.k8s.io'
      ])
    } catch {
      socket.destroy()
      return
    }
    const seen = [false, false]
    const queue: Buffer[] = []
    ws.on('open', () => {
      for (const chunk of queue.splice(0)) ws.send(Buffer.concat([Buffer.from([0]), chunk]))
    })
    ws.on('message', (raw: WebSocket.RawData) => {
      const data = raw as Buffer
      const channel = data[0]
      if (channel > 1) return
      if (!seen[channel]) {
        seen[channel] = true
        return
      }
      if (channel === 0) socket.write(data.subarray(1))
      else if (data.length > 1) socket.destroy()
    })
    ws.on('close', () => socket.destroy())
    ws.on('error', () => socket.destroy())
    socket.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([Buffer.from([0]), chunk]))
      else queue.push(chunk)
    })
    socket.on('close', () => ws.close())
  }

  stop(id: string): void {
    const forward = this.forwards.get(id)
    if (!forward) return
    this.forwards.delete(id)
    forward.server.close()
    for (const socket of forward.sockets) socket.destroy()
    this.notify()
  }

  stopFor(contextId: string): void {
    for (const forward of [...this.forwards.values()]) if (forward.info.contextId === contextId) this.stop(forward.info.id)
  }

  stopAll(): void {
    for (const id of [...this.forwards.keys()]) this.stop(id)
  }
}
