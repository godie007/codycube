// Administración sin YAML: datos de ConfigMaps y Secrets, crear Secrets por tipo, etiquetas, imagen,
// pausa de despliegues y taints. Solo corre contra el clúster desechable codycube-test.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { selectNamespaces } from './namespaces.mjs'

const kubeconfig = process.env.KUBECONFIG
const kubectl = (...args) => execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8' }).trim()
const kubectlIn = (input, ...args) => execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8', input }).trim()
if (kubectl('config', 'current-context') !== 'codycube-test') throw new Error('Solo corre contra el clúster desechable codycube-test')

const NS = 'admin-e2e'
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const unb64 = (text) => Buffer.from(text, 'base64').toString('utf8')
const BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString('base64')

kubectl('delete', 'namespace', NS, '--ignore-not-found', '--wait=true')
kubectl('create', 'namespace', NS)
kubectlIn(
  `apiVersion: v1
kind: ConfigMap
metadata: { name: app-config, namespace: ${NS} }
data: { LOG_LEVEL: info, OBSOLETA: borrar, ciudad: Bogotá }
---
apiVersion: v1
kind: Secret
metadata: { name: app-secret, namespace: ${NS} }
type: Opaque
data: { usuario: ${b64('admin')}, clave: ${b64('vieja')}, cert.bin: ${BINARY} }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: app, namespace: ${NS}, labels: { app: app } }
spec:
  replicas: 1
  selector: { matchLabels: { app: app } }
  template:
    metadata: { labels: { app: app } }
    spec:
      volumes: [{ name: secreto, secret: { secretName: app-secret } }]
      containers:
        - name: main
          image: busybox:1.36
          command: [sh, -c, 'sleep 3600']
          envFrom: [{ configMapRef: { name: app-config } }]
          env: [{ name: CLAVE, valueFrom: { secretKeyRef: { name: app-secret, key: clave } } }]
          volumeMounts: [{ name: secreto, mountPath: /secreto }]
`,
  'apply',
  '-f',
  '-'
)

const out = process.env.CODYCUBE_E2E_OUT ?? mkdtempSync(join(tmpdir(), 'codycube-admin-'))
mkdirSync(out, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'codycube-e2e-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, CODYCUBE_USER_DATA: userData, KUBECONFIG: kubeconfig, ELECTRON_RENDERER_URL: '' } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => message.type() === 'error' && errors.push(`console: ${message.text()}`))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
page.setDefaultTimeout(30_000)

const results = []
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) })
const step = async (name, fn) => {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`  ✗ ${name}: ${error.message.split('\n').slice(0, 3).join(' | ')}`)
    await shot(`fallo-${results.length}`).catch(() => {})
  }
}
const until = async (check, what, ms = 30_000) => {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await check()
      if (last) return last
    } catch (error) {
      last = error.message
    }
    await new Promise((done) => setTimeout(done, 400))
  }
  throw new Error(`No se cumplió: ${what} (último: ${last})`)
}
const sidebar = (label) => page.locator('.side-item', { hasText: new RegExp(`^${label}$`) }).click()
const row = (name) => page.locator('.grid-row', { has: page.locator('.cell.name', { hasText: new RegExp(`^${name}$`) }) }).first()
const details = () => page.locator('aside.details')
const action = (label) => details().locator('.actions .btn', { hasText: new RegExp(`^${label}$`) }).click()
const dialog = () => page.locator('form.dialog')
const submit = async () => {
  await dialog().locator('button[type=submit]').click()
  await dialog().waitFor({ state: 'detached' })
}
const toast = (text) => page.locator('.toast', { hasText: text }).first().waitFor()
const panel = () => page.getByTestId('data-panel').locator('visible=true')
const valueOf = (key) => panel().getByLabel(`Valor de ${key}`)
const json = (...args) => JSON.parse(kubectl(...args, '-o', 'json'))

try {
  await page.locator('.context', { hasText: 'codycube-test' }).getByRole('button', { name: 'Conectar' }).click()
  await selectNamespaces(page, [NS])

  await step('un ConfigMap dice quién lo usa', async () => {
    await sidebar('ConfigMaps')
    await row('app-config').click()
    const users = details().getByTestId('config-users')
    await users.getByText('Deployment/app').waitFor()
    if (!(await users.innerText()).includes('todas sus claves como variables (main)')) throw new Error(await users.innerText())
  })

  await step('edita un ConfigMap sin YAML: cambia, añade y quita claves, con resumen antes de guardar', async () => {
    await action('Editar datos')
    await valueOf('LOG_LEVEL').fill('debug')
    await panel().getByRole('button', { name: 'Quitar OBSOLETA' }).click()
    await panel().getByRole('button', { name: 'Añadir clave' }).click()
    await panel().getByLabel('Clave', { exact: true }).last().fill('config.yaml')
    await panel().getByLabel('Valor de config.yaml').fill('servidor:\n  puerto: 8080\n  nombre: ñandú')
    await shot('01-configmap-editado')
    await panel().getByRole('button', { name: 'Guardar' }).click()
    const summary = await dialog().innerText()
    for (const part of ['Añadidas: config.yaml', 'Cambiadas: LOG_LEVEL', 'Eliminadas: OBSOLETA']) if (!summary.includes(part)) throw new Error(`Resumen: ${summary}`)
    await submit()
    // Tras guardar ofrece reiniciar la Deployment, marcada porque usa las claves como variables
    await dialog().getByText('Aplicar el cambio en los pods').waitFor()
    const box = dialog().getByRole('checkbox', { name: /Deployment app/ })
    if (!(await box.isChecked())) throw new Error('La Deployment que usa envFrom debería venir marcada')
    await shot('02-reiniciar')
    await submit()
    await toast('Reinicio en curso: app')
    const cm = json('-n', NS, 'get', 'configmap', 'app-config')
    if (cm.data.LOG_LEVEL !== 'debug' || 'OBSOLETA' in cm.data || cm.data['config.yaml'] !== 'servidor:\n  puerto: 8080\n  nombre: ñandú' || cm.data.ciudad !== 'Bogotá') {
      throw new Error(JSON.stringify(cm.data))
    }
    await until(() => kubectl('-n', NS, 'get', 'deploy', 'app', '-o', 'jsonpath={.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}'), 'reinicio pedido')
  })

  await step('importa variables de un .env', async () => {
    await panel().getByRole('button', { name: 'Importar .env' }).click()
    await dialog().locator('textarea').fill('# comentario\nexport LOG_LEVEL=warn\nNUEVA="con espacios"\nmal formada')
    await submit()
    await toast('2 variables importadas; se ignoraron las líneas 4')
    if ((await valueOf('NUEVA').inputValue()) !== 'con espacios' || (await valueOf('LOG_LEVEL').inputValue()) !== 'warn') throw new Error('Importación incorrecta')
    await panel().getByRole('button', { name: 'Guardar' }).click()
    await submit()
    // No reinicia esta vez
    await dialog().getByText('Aplicar el cambio en los pods').waitFor()
    await dialog().getByRole('button', { name: 'Cancelar' }).click()
    await until(() => json('-n', NS, 'get', 'configmap', 'app-config').data.NUEVA === 'con espacios', 'NUEVA guardada')
  })

  await step('si otro cambió el ConfigMap, guardar da conflicto y no pisa su cambio', async () => {
    kubectl('-n', NS, 'patch', 'configmap', 'app-config', '--type=merge', '-p', '{"data":{"LOG_LEVEL":"de-otra-persona"}}')
    await valueOf('ciudad').fill('Medellín')
    await panel().getByRole('button', { name: 'Guardar' }).click()
    await submit()
    await page.locator('.toast.bad', { hasText: 'cambió en el clúster' }).first().waitFor()
    if (json('-n', NS, 'get', 'configmap', 'app-config').data.LOG_LEVEL !== 'de-otra-persona') throw new Error('Se pisó el cambio ajeno')
    await panel().getByRole('button', { name: 'Recargar' }).click()
    await until(async () => (await valueOf('LOG_LEVEL').inputValue()) === 'de-otra-persona', 'recarga lo nuevo')
  })

  await step('un Secret se edita en claro, oculto por defecto, y se guarda en base64 sin tocar los binarios', async () => {
    await sidebar('Secrets')
    await row('app-secret').click()
    await details().getByTestId('config-users').getByText('Deployment/app').waitFor()
    await action('Editar datos')
    if (await valueOf('clave').count()) throw new Error('El valor debería estar oculto')
    await panel().getByRole('button', { name: 'Mostrar clave' }).click()
    if ((await valueOf('clave').inputValue()) !== 'vieja') throw new Error('No descodifica')
    await valueOf('clave').fill('nueva-contraseña-🔐')
    if (!(await panel().locator('[data-key="cert.bin"]').innerText()).includes('Binario, 4 B')) throw new Error('El binario no se reconoce')
    await shot('03-secret')
    await panel().getByRole('button', { name: 'Guardar' }).click()
    await submit()
    await dialog().getByText('Aplicar el cambio en los pods').waitFor()
    await dialog().getByRole('button', { name: 'Cancelar' }).click()
    const secret = json('-n', NS, 'get', 'secret', 'app-secret')
    if (unb64(secret.data.clave) !== 'nueva-contraseña-🔐' || unb64(secret.data.usuario) !== 'admin' || secret.data['cert.bin'] !== BINARY) throw new Error(JSON.stringify(secret.data))
  })

  await step('crea un Secret de credenciales de registro desde un formulario', async () => {
    await page.getByRole('button', { name: 'Crear', exact: true }).click()
    await panel().getByLabel('Nombre', { exact: true }).fill('registro')
    await panel().getByLabel('Tipo de Secret').selectOption('kubernetes.io/tls')
    // TLS pide sus dos claves
    await panel().getByText('Este tipo de Secret necesita: tls.crt, tls.key').waitFor()
    await panel().getByLabel('Tipo de Secret').selectOption('kubernetes.io/dockerconfigjson')
    await panel().getByLabel('Servidor del registro').fill('ghcr.io')
    await panel().getByLabel('Usuario').fill('robot')
    await panel().getByLabel('Contraseña o token').fill('tok3n')
    await shot('04-registro')
    await panel().getByRole('button', { name: 'Crear' }).click()
    await toast('Secret registro creado')
    const secret = json('-n', NS, 'get', 'secret', 'registro')
    const auths = JSON.parse(unb64(secret.data['.dockerconfigjson'])).auths
    if (secret.type !== 'kubernetes.io/dockerconfigjson' || auths['ghcr.io'].auth !== b64('robot:tok3n')) throw new Error(JSON.stringify(secret))
    // La pestaña pasa a editar el Secret creado
    await page.locator('.dock-tab', { hasText: 'Datos: registro' }).waitFor()
  })

  await step('un ConfigMap inmutable se crea y luego no deja editar', async () => {
    await sidebar('ConfigMaps')
    await page.getByRole('button', { name: 'Crear', exact: true }).click()
    await panel().getByLabel('Nombre', { exact: true }).fill('fijo')
    await panel().getByRole('button', { name: 'Añadir clave' }).click()
    await panel().getByLabel('Clave', { exact: true }).last().fill('VERSION')
    await panel().getByLabel('Valor de VERSION').fill('1')
    await panel().getByRole('checkbox', { name: 'Inmutable' }).check()
    await panel().getByRole('button', { name: 'Crear' }).click()
    await toast('ConfigMap fijo creado')
    await panel().getByText('es inmutable').waitFor()
    if (!(await panel().getByRole('button', { name: 'Guardar' }).isDisabled())) throw new Error('Guardar habilitado en un inmutable')
    if (json('-n', NS, 'get', 'configmap', 'fijo').immutable !== true) throw new Error('No quedó inmutable')
  })

  await step('etiquetas y anotaciones sin YAML, conservando la de kubectl', async () => {
    await sidebar('Deployments')
    await row('app').click()
    await action('Etiquetas')
    const labels = dialog().getByLabel('Etiquetas (clave=valor por línea)')
    await labels.fill(`${await labels.inputValue()}\nequipo=pagos`)
    await dialog().getByLabel('Anotaciones (clave=valor por línea)').fill('responsable=ana@ejemplo.dev')
    await submit()
    await toast('Etiquetas y anotaciones guardadas')
    const deploy = json('-n', NS, 'get', 'deploy', 'app')
    if (deploy.metadata.labels.equipo !== 'pagos' || deploy.metadata.labels.app !== 'app') throw new Error(JSON.stringify(deploy.metadata.labels))
    if (deploy.metadata.annotations.responsable !== 'ana@ejemplo.dev') throw new Error(JSON.stringify(deploy.metadata.annotations))
    if (!deploy.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']) throw new Error('Se perdió la anotación de kubectl')
  })

  await step('cambia la imagen y pausa y reanuda el despliegue', async () => {
    await action('Cambiar imagen')
    await dialog().getByLabel('main').fill('busybox:1.37')
    await submit()
    await toast('Imagen actualizada: main → busybox:1.37')
    await until(() => kubectl('-n', NS, 'get', 'deploy', 'app', '-o', 'jsonpath={.spec.template.spec.containers[0].image}') === 'busybox:1.37', 'imagen nueva')
    await action('Pausar despliegue')
    await until(() => kubectl('-n', NS, 'get', 'deploy', 'app', '-o', 'jsonpath={.spec.paused}') === 'true', 'en pausa')
    await details().locator('.actions .btn', { hasText: 'Reanudar despliegue' }).waitFor()
    await action('Reanudar despliegue')
    await until(() => kubectl('-n', NS, 'get', 'deploy', 'app', '-o', 'jsonpath={.spec.paused}') !== 'true', 'reanudado')
  })

  await step('añade y quita un taint en el nodo', async () => {
    await selectNamespaces(page, [])
    await sidebar('Nodos')
    await page.locator('.grid-row').first().click()
    const node = await details().locator('h2').innerText()
    await action('Taints')
    await dialog().locator('textarea').fill('codycube-e2e=si:PreferNoSchedule')
    await submit()
    await toast('Taints guardados')
    await until(() => kubectl('get', 'node', node, '-o', 'jsonpath={.spec.taints[*].key}').includes('codycube-e2e'), 'taint puesto')
    await until(async () => (await details().locator('.actions .btn', { hasText: /^Taints$/ }).isEnabled()), 'detalles al día')
    await page.waitForTimeout(500)
    await action('Taints')
    if ((await dialog().locator('textarea').inputValue()) !== 'codycube-e2e=si:PreferNoSchedule') throw new Error('No muestra el taint actual')
    await dialog().locator('textarea').fill('')
    await submit()
    await until(() => !kubectl('get', 'node', node, '-o', 'jsonpath={.spec.taints[*].key}').includes('codycube-e2e'), 'taint quitado')
  })

  await step('en solo lectura se ven los datos pero no se guardan', async () => {
    await page.getByLabel('Solo lectura').check()
    await selectNamespaces(page, [NS])
    await sidebar('Secrets')
    await row('app-secret').click()
    await action('Ver datos')
    await panel().getByText('Modo solo lectura').waitFor()
    if (!(await panel().getByRole('button', { name: 'Guardar' }).isDisabled())) throw new Error('Guardar habilitado en solo lectura')
    // Aunque la interfaz fallara, el proceso principal se niega
    const denied = await page.evaluate(
      async (ns) => {
        try {
          const contexts = await window.codycube.invoke('config:list')
          const id = contexts.contexts.find((c) => c.name === 'codycube-test').id
          await window.codycube.invoke('resource:set-data', id, { resource: { group: '', version: 'v1', plural: 'secrets', kind: 'Secret', namespaced: true, verbs: [], shortNames: [], scalable: false }, namespace: ns, name: 'app-secret' }, '1', { data: {} })
          return 'permitido'
        } catch (error) {
          return String(error.message)
        }
      },
      NS
    )
    if (!/solo lectura/i.test(denied)) throw new Error(`El proceso principal no bloqueó: ${denied}`)
    await page.getByLabel('Solo lectura').uncheck()
  })
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} pasos correctos. Capturas en ${out}`)
  const realErrors = errors.filter((e) => !/Failed to load resource/.test(e))
  if (realErrors.length) console.log(`Errores en la interfaz:\n  ${[...new Set(realErrors)].slice(0, 15).join('\n  ')}`)
  await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
  try {
    kubectl('delete', 'namespace', NS, '--wait=false')
  } catch {
    // Limpieza de cortesía
  }
  process.exitCode = failed.length || realErrors.length ? 1 : 0
}
