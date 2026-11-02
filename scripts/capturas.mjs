// Genera las capturas de la documentación manejando la app real con Playwright.
//
//   npm run build
//   KUBECONFIG=… node scripts/capturas.mjs [carpeta]
//
// Solo corre contra el clúster desechable `codycube-test` con la demo de Dapr (tests/dapr-demo.yaml)
// y los objetos de tests/fixtures.yaml. Crea algunos objetos de ejemplo y los borra al terminar.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const kubeconfig = process.env.KUBECONFIG
const kubectl = (...args) => execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8' }).trim()
const kubectlIn = (input, ...args) => execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8', input }).trim()
if (kubectl('config', 'current-context') !== 'codycube-test') throw new Error('Solo corre contra el clúster desechable codycube-test')

const out = resolve(process.argv[2] ?? 'codycube-obsidian/Adjuntos/capturas')
mkdirSync(out, { recursive: true })
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')

// Objetos de ejemplo con nombres creíbles
kubectlIn(
  `apiVersion: v1
kind: Secret
metadata: { name: pagos-credenciales, namespace: tienda, labels: { app: payments, equipo: pagos } }
type: Opaque
data:
  DATABASE_URL: ${b64('postgres://pagos:••••@postgres.tienda:5432/pagos?sslmode=require')}
  STRIPE_API_KEY: ${b64('sk_test_51Hx••••••••••••••••')}
  WEBHOOK_SECRET: ${b64('whsec_••••••••••••')}
`,
  'apply',
  '-f',
  '-'
)
// payments lee el Secret como variables: así «Usado por» tiene algo que enseñar
const PAYMENTS_ENV = '{"spec":{"template":{"spec":{"containers":[{"name":"app","envFrom":[{"secretRef":{"name":"pagos-credenciales","optional":true}}]}]}}}}'
kubectl('-n', 'tienda', 'patch', 'deploy', 'payments', '--type=strategic', '-p', PAYMENTS_ENV)
kubectl('-n', 'tienda', 'rollout', 'status', 'deploy/payments', '--timeout=180s')

const chart = mkdtempSync(join(tmpdir(), 'codycube-chart-'))
mkdirSync(join(chart, 'templates'))
writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: monitor\nversion: 1.4.0\nappVersion: "2.3"\ndescription: Panel de estado de ejemplo\n')
writeFileSync(join(chart, 'values.yaml'), 'replicas: 1\ncolor: azul\n')
writeFileSync(join(chart, 'templates/cm.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: {{ .Release.Name }}-config }\ndata: { color: {{ .Values.color | quote }} }\n')
let helmReady = false
try {
  execFileSync('helm', ['--kubeconfig', kubeconfig, 'upgrade', '--install', 'monitor', chart, '-n', 'demo'], { stdio: 'ignore' })
  execFileSync('helm', ['--kubeconfig', kubeconfig, 'upgrade', 'monitor', chart, '-n', 'demo', '--set', 'color=verde'], { stdio: 'ignore' })
  helmReady = true
} catch {
  console.log('  (sin helm en el PATH: se omite la captura de Helm)')
}

const userData = mkdtempSync(join(tmpdir(), 'codycube-capturas-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, CODYCUBE_USER_DATA: userData, KUBECONFIG: kubeconfig, ELECTRON_RENDERER_URL: '' } })
const page = await app.firstWindow()
page.setDefaultTimeout(45_000)
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h])
await size(1440, 900)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const shots = []
/** Los avisos taparían la captura: se ocultan solo en el momento de la foto */
const shot = async (name, settle = 600) => {
  await sleep(settle)
  await page.addStyleTag({ content: '.toasts, .toast { display: none !important }' }).then((el) => el.evaluate((node) => node.setAttribute('data-captura', '')))
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.locator('style[data-captura]').evaluateAll((nodes) => nodes.forEach((n) => n.remove()))
  shots.push(name)
  console.log(`  ✓ ${name}.png`)
}
const sidebar = (label) => page.locator('.side-item', { hasText: new RegExp(`^${label}$`) }).click()
const row = (name) => page.locator('.grid-row', { has: page.locator('.cell.name', { hasText: new RegExp(`^${name}`) }) }).first()
const details = () => page.locator('aside.details')
const action = (label) => details().locator('.actions .btn', { hasText: new RegExp(`^${label}$`) }).click()
const dialog = () => page.locator('form.dialog')
const closeDialog = async () => {
  await dialog().getByRole('button', { name: 'Cancelar' }).click()
  await dialog().waitFor({ state: 'detached' })
}
const closeTabs = async () => {
  for (const close of await page.locator('.dock-tab button[aria-label^="Cerrar"]').all().then((all) => all.reverse())) await close.click()
}
const namespaces = async (names) => {
  const button = page.getByRole('button', { name: 'Filtro de namespaces' })
  await button.click()
  const list = page.getByRole('listbox', { name: 'Namespaces' })
  await list.getByRole('checkbox', { name: 'Todos los namespaces' }).check()
  for (const name of names) await list.getByRole('checkbox', { name, exact: true }).check()
  await page.keyboard.press('Escape')
}

try {
  await page.locator('.context', { hasText: 'codycube-test' }).waitFor()
  // La ruta real del kubeconfig de pruebas es una carpeta temporal: se muestra una de ejemplo
  await page.locator('.home code[title]').first().evaluate((el, path) => { el.textContent = path; el.title = path }, '~/.kube/config')
  await shot('bienvenida', 1500)

  await page.locator('.context', { hasText: 'codycube-test' }).getByRole('button', { name: 'Conectar' }).click()
  await page.getByTestId('pods-total').waitFor()
  await sleep(4000) // métricas de metrics-server
  await shot('resumen')

  // Arquitectura con tráfico medido
  await namespaces(['tienda'])
  await sidebar('Arquitectura')
  await page.getByTestId('live-state').filter({ hasText: 'En vivo' }).waitFor({ timeout: 90_000 })
  await sleep(12_000) // que las tasas se asienten
  await shot('arquitectura', 1500)
  const edge = page.locator('[data-edge="invoke|workload:tienda/Deployment/gateway|workload:tienda/Deployment/orders"]')
  const point = await edge.locator('.gedge-hit').evaluate((path) => {
    const p = path.getPointAtLength(path.getTotalLength() * 0.3).matrixTransform(path.getScreenCTM())
    return { x: p.x, y: p.y }
  })
  await page.mouse.click(point.x, point.y)
  await page.getByTestId('inspector').waitFor()
  await sleep(6000) // la gráfica del panel acumula lecturas
  await shot('arquitectura-conexion')
  await page.getByTestId('inspector').getByRole('button', { name: 'Cerrar panel' }).click()
  await page.getByRole('button', { name: 'Tabla', exact: true }).click()
  await page.getByTestId('connections').waitFor()
  await shot('arquitectura-tabla', 1500)
  await page.getByRole('button', { name: 'Diagrama', exact: true }).click().catch(() => {})

  // Filtro de varios namespaces
  await namespaces(['demo', 'tienda'])
  await sidebar('Pods')
  await row('gateway').waitFor()
  await page.getByRole('button', { name: 'Filtro de namespaces' }).click()
  await page.getByRole('listbox', { name: 'Namespaces' }).getByRole('checkbox', { name: 'kube-system', exact: true }).hover()
  await shot('namespaces')
  await page.keyboard.press('Escape')

  // Detalle de una Deployment, con registros
  await namespaces(['tienda'])
  await sidebar('Deployments')
  await row('orders').click()
  await details().getByText('Pods', { exact: false }).first().waitFor()
  await action('Registros')
  await page.locator('.log-line').first().waitFor().catch(() => {})
  await shot('deployment-registros', 3000)
  await closeTabs()

  // Terminal en un pod
  await namespaces(['demo'])
  await sidebar('Pods')
  await row('web').click()
  await action('Terminal')
  await page.locator('.xterm').first().waitFor()
  await sleep(1500)
  await page.locator('.xterm').first().click()
  await page.keyboard.type('cat /etc/os-release | head -3 && nginx -v\n')
  await shot('terminal', 2000)
  await closeTabs()

  // Editar YAML
  await namespaces(['tienda'])
  await sidebar('Deployments')
  await row('payments').click()
  await action('Editar YAML')
  await page.getByTestId('yaml-editor').locator('.cm-content').waitFor()
  await shot('yaml', 1500)
  await closeTabs()

  // ConfigMap usado por varias cargas
  await sidebar('ConfigMaps')
  await row('app-code').click()
  await details().getByTestId('config-users').waitFor()
  await shot('configmap-usado-por', 1000)

  // Editor de datos de un Secret
  await sidebar('Secrets')
  await row('pagos-credenciales').click()
  await action('Editar datos')
  const panel = page.getByTestId('data-panel').locator('visible=true')
  await panel.getByRole('button', { name: 'Mostrar DATABASE_URL' }).click()
  await panel.getByLabel('Valor de DATABASE_URL').fill('postgres://pagos:••••@postgres.tienda:5432/pagos?sslmode=verify-full')
  await panel.getByRole('button', { name: 'Añadir clave' }).click()
  await panel.getByLabel('Clave', { exact: true }).last().fill('LOG_LEVEL')
  await panel.getByLabel('Valor de LOG_LEVEL').fill('info')
  await shot('secret-editor')
  await panel.getByRole('button', { name: 'Guardar' }).click()
  await shot('secret-guardar', 400)
  await closeDialog()
  await closeTabs()

  // Crear un Secret de registro
  await page.getByRole('button', { name: 'Crear', exact: true }).click()
  const create = page.getByTestId('data-panel').locator('visible=true')
  await create.getByLabel('Nombre', { exact: true }).fill('ghcr-credenciales')
  await create.getByLabel('Tipo de Secret').selectOption('kubernetes.io/dockerconfigjson')
  await create.getByLabel('Servidor del registro').fill('ghcr.io')
  await create.getByLabel('Usuario').fill('ci-robot')
  await create.getByLabel('Contraseña o token').fill('ghp_ejemplo_no_real')
  await shot('secret-crear')
  await closeTabs()

  // Acciones de una carga: imagen y etiquetas
  await sidebar('Deployments')
  await row('orders').click()
  await action('Cambiar imagen')
  await dialog().waitFor()
  await shot('cambiar-imagen', 400)
  await closeDialog()
  await action('Etiquetas')
  await dialog().waitFor()
  await shot('etiquetas', 400)
  await closeDialog()

  // Nodo con sus acciones
  await namespaces([])
  await sidebar('Nodos')
  await page.locator('.grid-row').first().click()
  await details().locator('.actions .btn', { hasText: /^Drenar$/ }).waitFor()
  await shot('nodo', 1500)
  await action('Taints')
  await dialog().locator('textarea').fill('dedicado=gpu:NoSchedule')
  await shot('nodo-taints', 400)
  await closeDialog()

  // Recursos personalizados
  await sidebar('Gadget').catch(() => page.locator('.side-group', { hasText: 'ejemplo.dev' }).locator('.side-item', { hasText: 'Gadget' }).click())
  await row('rojo').waitFor()
  await shot('crd')

  if (helmReady) {
    await sidebar('Releases')
    await page.getByText('monitor').first().waitFor()
    await page.getByText('monitor').first().click()
    await shot('helm', 1500)
  }

} finally {
  await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
  rmSync(chart, { recursive: true, force: true })
  try {
    kubectl('-n', 'tienda', 'patch', 'deploy', 'payments', '--type=json', '-p', '[{"op":"remove","path":"/spec/template/spec/containers/0/envFrom"}]')
    kubectl('-n', 'tienda', 'delete', 'secret', 'pagos-credenciales', '--ignore-not-found')
    if (helmReady) execFileSync('helm', ['--kubeconfig', kubeconfig, 'uninstall', 'monitor', '-n', 'demo'], { stdio: 'ignore' })
  } catch {
    // limpieza de cortesía
  }
  console.log(`\n${shots.length} capturas en ${out}`)
}
