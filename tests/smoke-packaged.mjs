// Comprueba la app empaquetada (dist/Codycube.app) contra el clúster desechable, y que una tabla se
// recupera sola si el servidor de API se reinicia.
//
//   KUBECONFIG=/ruta/test.yaml node tests/smoke-packaged.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { selectNamespaces } from './namespaces.mjs'

const kubeconfig = process.env.KUBECONFIG
const kubectl = (...args) => execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8' }).trim()
if (kubectl('config', 'current-context') !== 'codycube-test') throw new Error('Solo corre contra el clúster desechable codycube-test')

const userData = realpathSync(mkdtempSync(join(tmpdir(), 'codycube-smoke-')))
const realData = join(homedir(), 'Library/Application Support/codycube')
const hadRealData = existsSync(realData)
const app = await electron.launch({
  executablePath: resolve('dist/Codycube.app/Contents/MacOS/Codycube'),
  args: [`--user-data-dir=${userData}`],
  env: { ...process.env, KUBECONFIG: kubeconfig, ELECTRON_RENDERER_URL: '' }
})
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  await page.locator('.context', { hasText: 'codycube-test' }).getByRole('button', { name: 'Conectar' }).click()
  await page.getByTestId('nodes-ready').waitFor()
  console.log('✓ la app empaquetada conecta sin node_modules')

  const packaged = await app.evaluate(({ app: electronApp }) => ({ packaged: electronApp.isPackaged, name: electronApp.getName(), userData: electronApp.getPath('userData') }))
  if (!packaged.packaged) throw new Error('No se está probando la versión empaquetada')
  if (packaged.userData !== userData) throw new Error(`Datos fuera de la carpeta temporal: ${packaged.userData}`)
  if (!hadRealData && existsSync(realData)) throw new Error('La prueba escribió en los datos reales')
  console.log(`✓ ${packaged.name} empaquetada, con datos aislados`)

  await page.locator('.side-item', { hasText: /^ConfigMaps$/ }).click()
  await selectNamespaces(page, ['demo'])
  await page.locator('.grid-row', { hasText: 'ajustes' }).waitFor()

  execFileSync('docker', ['restart', 'codycube-test'], { stdio: 'ignore' })
  console.log('… servidor de API reiniciado')
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      kubectl('-n', 'demo', 'create', 'configmap', 'tras-reinicio', '--from-literal=a=b')
      break
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((done) => setTimeout(done, 2000))
    }
  }
  await page.locator('.grid-row', { hasText: 'tras-reinicio' }).waitFor({ timeout: 90_000 })
  console.log('✓ la tabla se reconecta sola y muestra lo creado después del reinicio')
  kubectl('-n', 'demo', 'delete', 'configmap', 'tras-reinicio')
} finally {
  await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
}
