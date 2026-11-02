// Lectura del formato de texto de Prometheus y cálculo de tasas entre dos muestras.

export interface Sample {
  name: string
  labels: Record<string, string>
  value: number
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/

/** Etiquetas `a="1",b="x\"y"`. No se puede partir por comas: los valores pueden contenerlas */
function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {}
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    labels[match[1]] = match[2].replace(/\\(["\\n])/g, (_, c: string) => (c === 'n' ? '\n' : c))
  }
  return labels
}

/** Convierte la exposición de métricas en muestras, ignorando comentarios y líneas no válidas */
export function parseMetrics(text: string, keep?: (name: string) => boolean): Sample[] {
  const samples: Sample[] = []
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const match = LINE.exec(line)
    if (!match || (keep && !keep(match[1]))) continue
    const value = Number(match[3] === '+Inf' ? Infinity : match[3] === '-Inf' ? -Infinity : match[3])
    if (Number.isNaN(value)) continue
    samples.push({ name: match[1], labels: match[2] ? parseLabels(match[2]) : {}, value })
  }
  return samples
}

/**
 * Incremento de un contador entre dos lecturas. Si bajó, el proceso se reinició y empezó de cero:
 * el valor nuevo es lo acumulado desde entonces, como hace `rate()` de Prometheus.
 */
export function counterDelta(previous: number | undefined, current: number): number {
  if (previous === undefined) return 0
  return current < previous ? current : current - previous
}

/**
 * Percentil de un histograma con buckets acumulados `le`, interpolando dentro del bucket como
 * `histogram_quantile`. Devuelve undefined si no hay observaciones.
 */
export function histogramQuantile(quantile: number, buckets: { le: number; count: number }[]): number | undefined {
  const sorted = [...buckets].sort((a, b) => a.le - b.le)
  const total = sorted[sorted.length - 1]?.count ?? 0
  if (total <= 0) return undefined
  const rank = quantile * total
  let lowerBound = 0
  let lowerCount = 0
  for (const bucket of sorted) {
    if (bucket.count >= rank) {
      // El último bucket no tiene techo: lo más que se puede afirmar es el límite anterior
      if (!Number.isFinite(bucket.le)) return lowerBound
      const inBucket = bucket.count - lowerCount
      return inBucket === 0 ? bucket.le : lowerBound + (bucket.le - lowerBound) * ((rank - lowerCount) / inBucket)
    }
    lowerBound = bucket.le
    lowerCount = bucket.count
  }
  return lowerBound
}
