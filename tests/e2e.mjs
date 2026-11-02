// Prueba de extremo a extremo: abre la app real (compilada) y la usa como una persona contra un
// clúster DESECHABLE. Exige KUBECONFIG apuntando a un contexto llamado "codycube-test" y se niega a
// correr con cualquier otro, para que jamás toque un clúster de verdad.
//
//   KUBECONFIG=/ruta/test.yaml CODYCUBE_E2E_OUT=/ruta/capturas node tests/e2e.mjs
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { selectNamespaces } from './namespaces.mjs'

const kubeconfig = process.env.KUBECONFIG
const kubectl = (...args) => execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8' }).trim()
if (kubectl('config', 'current-context') !== 'codycube-test') throw new Error('Solo corre contra el clúster desechable codycube-test')

// Un Job manual de una corrida anterior contaría como pod de más
kubectl('-n', 'demo', 'delete', 'jobs', '--all', '--wait=true')

const out = process.env.CODYCUBE_E2E_OUT ?? mkdtempSync(join(tmpdir(), 'codycube-shots-'))
mkdirSync(out, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'codycube-e2e-'))

const results = []
let second
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, CODYCUBE_USER_DATA: userData, KUBECONFIG: kubeconfig, ELECTRON_RENDERER_URL: '' }
})
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => message.type() === 'error' && errors.push(`console: ${message.text()}`))
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
page.setDefaultTimeout(30_000)

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
const until = async (check, what, ms = 45_000) => {
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
const row = (name) => page.locator('.grid-row', { has: page.locator('.cell.name', { hasText: name }) }).first()
const details = () => page.locator('aside.details')
const action = (label) => details().locator('.actions .btn', { hasText: new RegExp(`^${label}$`) }).click()
const confirmDialog = async (word, button) => {
  const dialog = page.locator('form.dialog')
  if (word) await dialog.getByLabel('Confirmación').fill(word)
  await dialog.locator('button[type=submit]', button ? { hasText: button } : {}).click()
  await dialog.waitFor({ state: 'detached' })
}
const editorText = (scope) => scope.locator('.cm-content').evaluate((el) => el.cmView?.view?.state.doc.toString() ?? el.innerText)
const setEditor = async (scope, text) => {
  await scope.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
}
const toast = (text) => page.locator('.toast', { hasText: text }).first().waitFor()

try {
  await step('la ventana es segura: sin Node en la interfaz, CSP y contexto aislado', async () => {
    const info = await page.evaluate(() => ({
      node: typeof window.require,
      process: typeof window.process,
      bridge: typeof window.codycube?.invoke,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ''
    }))
    if (info.node !== 'undefined' || info.process !== 'undefined') throw new Error(`Node expuesto: ${JSON.stringify(info)}`)
    if (info.bridge !== 'function') throw new Error('Falta el puente')
    if (!info.csp.includes("script-src 'self'")) throw new Error(`CSP: ${info.csp}`)
  })

  await step('detecta $KUBECONFIG al iniciar y lista el contexto', async () => {
    await page.locator('.context', { hasText: 'codycube-test' }).waitFor()
    await shot('01-inicio')
  })

  await step('rechaza con un mensaje un kubeconfig no válido pegado', async () => {
    await page.getByRole('button', { name: 'Pegar texto' }).click()
    await page.getByRole('dialog').locator('textarea').fill('esto: no-es-un-kubeconfig')
    await page.getByRole('dialog').getByRole('button', { name: 'Cargar' }).click()
    await page.locator('.toast.bad').first().waitFor()
  })

  await step('conecta y muestra el resumen con nodos y pods reales', async () => {
    await page.locator('.context', { hasText: 'codycube-test' }).getByRole('button', { name: 'Conectar' }).click()
    await until(async () => (await page.getByTestId('nodes-ready').innerText()).startsWith('1'), 'un nodo listo')
    await until(async () => Number(await page.getByTestId('pods-total').innerText()) >= 3, 'pods contados')
    await page.waitForTimeout(1500)
    await shot('02-resumen')
  })

  await step('todas las secciones anunciadas abren sin error', async () => {
    const labels = await page.locator('.side-item').allInnerTexts()
    const failed = []
    for (const label of labels) {
      await sidebar(label.replace(/[()]/g, '\\$&'))
      await page.waitForTimeout(150)
      await until(async () => !(await page.locator('.empty', { hasText: 'Cargando' }).count()), `${label} carga`, 15_000)
      if (await page.locator('.empty', { hasText: 'No se pudo cargar' }).count()) failed.push(label)
    }
    if (failed.length) throw new Error(`Con error: ${failed}`)
    console.log(`    ${labels.length} secciones`)
  })

  await step('filtra por namespace', async () => {
    await selectNamespaces(page, ['demo'])
    await sidebar('Pods')
    await until(async () => (await page.getByTestId('row-count').innerText()).startsWith('3'), '3 pods en demo')
    await row('logger-').waitFor()
    await shot('03-pods')
  })

  await step('la tabla busca y ordena', async () => {
    await page.getByLabel('Buscar').fill('web-')
    await until(async () => (await page.getByTestId('row-count').innerText()) === '1 de 3', 'búsqueda deja 1')
    await page.getByLabel('Buscar').fill('app=logger')
    await until(async () => (await page.getByTestId('row-count').innerText()) === '2 de 3', 'búsqueda por etiqueta')
    await page.getByLabel('Buscar').fill('')
    await page.locator('.grid-head button', { hasText: 'Nombre' }).click()
    await page.locator('.grid-head button', { hasText: 'Nombre' }).click()
    const first = await page.locator('.grid-row .cell.name').first().innerText()
    if (!first.startsWith('web-')) throw new Error(`Orden descendente: ${first}`)
  })

  await step('la tabla se actualiza sola al crear un objeto fuera de la app (watch)', async () => {
    await sidebar('ConfigMaps')
    await row('ajustes').waitFor()
    kubectl('-n', 'demo', 'create', 'configmap', 'externo', '--from-literal=a=b')
    await row('externo').waitFor()
    kubectl('-n', 'demo', 'delete', 'configmap', 'externo')
    await row('externo').waitFor({ state: 'detached' })
  })

  await step('muestra detalles y datos de un ConfigMap', async () => {
    await row('ajustes').click()
    await details().getByText('produccion', { exact: true }).waitFor()
    await details().getByRole('button', { name: 'Cerrar detalles' }).click()
  })

  await step('oculta un Secret hasta pedirlo y lo decodifica en UTF-8', async () => {
    await sidebar('Secrets')
    await row('clave').click()
    await details().locator('pre', { hasText: '••••' }).waitFor()
    if ((await details().innerText()).includes('súper-secreto')) throw new Error('Secreto visible sin pedirlo')
    await details().getByRole('button', { name: 'Mostrar' }).click()
    await details().getByText('súper-secreto').waitFor()
    await details().getByRole('button', { name: 'Cerrar detalles' }).click()
  })

  await step('registros en vivo de un pod: llegan líneas nuevas y se filtran', async () => {
    await sidebar('Pods')
    await page.getByLabel('Buscar').fill('logger-')
    await row('logger-').click()
    await action('Registros')
    const body = page.getByTestId('log-body')
    await body.getByText(/linea-\d+ de logger/).first().waitFor()
    const count = async () => Number((await page.getByTestId('log-count').innerText()).split(' ')[0])
    const before = await count()
    await until(async () => (await count()) > before, 'llegan líneas nuevas (follow)', 15_000)
    await page.getByLabel('Filtrar registros').fill('linea-0 ')
    await until(async () => (await count()) <= 1, 'el filtro reduce las líneas')
    await page.getByLabel('Filtrar registros').fill('')
    await page.getByRole('button', { name: /Cerrar Registros/ }).click()
    await details().getByRole('button', { name: 'Cerrar detalles' }).click()
    await page.getByLabel('Buscar').fill('')
  })

  await step('registros de un Deployment: combina los 2 pods', async () => {
    await sidebar('Deployments')
    await row('logger').click()
    await details().getByText('Pods (2)').waitFor()
    await action('Registros')
    await until(async () => (await page.getByLabel('Pod', { exact: true }).locator('option').count()) === 3, 'selector con 2 pods y Todos')
    const sources = await until(async () => {
      const text = await page.getByTestId('log-body').innerText()
      const names = new Set(text.match(/logger-[a-z0-9]+-[a-z0-9]+ linea/g) ?? [])
      return names.size === 2 ? names : false
    }, 'líneas de los 2 pods')
    console.log(`    fuentes: ${sources.size}`)
    await page.waitForTimeout(500)
    await shot('04-registros')
    await page.getByRole('button', { name: /Cerrar Registros/ }).click()
  })

  await step('escala un Deployment y el cambio llega al clúster y a la tabla', async () => {
    await action('Escalar')
    await page.getByRole('dialog').getByLabel('Réplicas').fill('3')
    await confirmDialog(null, 'Escalar')
    await until(() => kubectl('-n', 'demo', 'get', 'deploy', 'logger', '-o', 'jsonpath={.spec.replicas}') === '3', 'réplicas=3')
    await until(async () => (await row('logger').innerText()).includes('3/3'), 'tabla muestra 3/3', 60_000)
    await action('Escalar')
    await page.getByRole('dialog').getByLabel('Réplicas').fill('2')
    await confirmDialog(null, 'Escalar')
    await until(() => kubectl('-n', 'demo', 'get', 'deploy', 'logger', '-o', 'jsonpath={.spec.replicas}') === '2', 'réplicas=2')
  })

  await step('reinicia y luego revierte un Deployment', async () => {
    const revisionOf = () => kubectl('-n', 'demo', 'get', 'deploy', 'logger', '-o', 'jsonpath={.metadata.annotations.deployment\\.kubernetes\\.io/revision}')
    const start = Number(revisionOf())
    await action('Reiniciar')
    await confirmDialog(null, 'Reiniciar')
    await until(() => Number(revisionOf()) === start + 1, 'nueva revisión')
    const annotation = kubectl('-n', 'demo', 'get', 'deploy', 'logger', '-o', 'jsonpath={.spec.template.metadata.annotations}')
    if (!annotation.includes('restartedAt')) throw new Error('Sin anotación de reinicio')
    kubectl('-n', 'demo', 'rollout', 'status', 'deploy/logger', '--timeout=120s')
    await action('Revertir')
    await page.getByRole('dialog').locator('select').waitFor()
    await confirmDialog(null, 'Revertir')
    await until(() => !kubectl('-n', 'demo', 'get', 'deploy', 'logger', '-o', 'jsonpath={.spec.template.metadata.annotations}').includes('restartedAt'), 'plantilla anterior restaurada')
    kubectl('-n', 'demo', 'rollout', 'status', 'deploy/logger', '--timeout=120s')
    await details().getByRole('button', { name: 'Cerrar detalles' }).click()
  })

  await step('terminal en un pod: ejecuta un comando y devuelve su salida', async () => {
    await sidebar('Pods')
    await page.getByLabel('Buscar').fill('web-')
    await row('web-').click()
    await action('Terminal')
    const terminal = page.getByTestId('terminal')
    await terminal.locator('.xterm-screen').waitFor()
    await page.waitForTimeout(1500)
    await terminal.locator('.xterm-screen').click()
    await page.keyboard.type('echo $((6*7))-eco\n', { delay: 15 })
    await until(async () => (await terminal.locator('.xterm-rows').innerText()).includes('42-eco'), 'salida del comando', 15_000)
    await page.keyboard.type('stty size\n', { delay: 15 })
    await until(async () => /\n\d+ \d+\n/.test(await terminal.locator('.xterm-rows').innerText()), 'tamaño de terminal enviado', 10_000)
    const size = (await terminal.locator('.xterm-rows').innerText()).match(/\n(\d+) (\d+)\n/)
    if (size[2] === '80' && size[1] === '24') throw new Error('El servidor no recibió el tamaño real')
    await shot('05-terminal')
    await page.getByRole('button', { name: /Cerrar Terminal/ }).click()
    await details().getByRole('button', { name: 'Cerrar detalles' }).click()
    await page.getByLabel('Buscar').fill('')
  })

  await step('reenvía el puerto de un Service y responde nginx', async () => {
    await sidebar('Services')
    await row('web').click()
    await action('Reenviar puerto')
    await confirmDialog(null, 'Iniciar')
    await sidebar('Reenvío de puertos')
    const local = await page.getByTestId('forward-local').innerText()
    const port = Number(local.split(':')[1])
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve(text))
      }).on('error', reject)
    })
    if (!body.includes('Welcome to nginx')) throw new Error(`Respuesta: ${body.slice(0, 80)}`)
    await page.getByRole('button', { name: 'Detener' }).click()
    await page.getByText('Sin reenvíos activos').waitFor()
  })

  await step('simula y aplica YAML de varios documentos', async () => {
    await sidebar('ConfigMaps')
    await page.getByRole('button', { name: 'Crear' }).click()
    // ConfigMaps y Secrets abren un formulario; desde ahí se pasa al YAML
    await page.getByTestId('data-panel').getByRole('button', { name: 'Usar YAML' }).click()
    const panel = page.locator('.yaml').first()
    await panel.locator('.cm-content').waitFor()
    await setEditor(panel, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: desde-yaml\ndata:\n  x: "1"\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: desde-yaml-2\n')
    await panel.getByRole('button', { name: 'Simular' }).click()
    await toast('Simulación correcta')
    if (kubectl('-n', 'demo', 'get', 'cm', '--no-headers').includes('desde-yaml')) throw new Error('La simulación persistió')
    await panel.getByRole('button', { name: 'Aplicar' }).click()
    await toast('Aplicado')
    await row('desde-yaml-2').waitFor()
  })

  await step('muestra el error del servidor con YAML inválido', async () => {
    const panel = page.locator('.yaml').first()
    await setEditor(panel, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: "NOMBRE_INVALIDO"\n')
    await panel.getByRole('button', { name: 'Aplicar' }).click()
    await page.locator('.toast.bad', { hasText: /invalid|Invalid/ }).first().waitFor()
    await page.getByRole('button', { name: /Cerrar Crear recurso/ }).click()
  })

  await step('edita YAML y detecta conflictos con cambios concurrentes', async () => {
    await row('desde-yaml').first().click()
    await action('Editar YAML')
    const panel = page.locator('.yaml').first()
    await until(async () => (await panel.locator('.cm-content').innerText()).includes('resourceVersion'), 'YAML cargado')
    await page.waitForTimeout(300)
    const name = await details().locator('h2').innerText()
    kubectl('-n', 'demo', 'annotate', 'cm', name, 'cambio=externo')
    const text = await editorText(panel)
    await setEditor(panel, text.replace(/^kind: ConfigMap$/m, 'kind: ConfigMap\nimmutable: false'))
    await panel.getByRole('button', { name: 'Guardar' }).click()
    await page.locator('.toast.bad', { hasText: /modified|conflict|changes/i }).first().waitFor()
    await panel.getByRole('button', { name: 'Recargar' }).click()
    await until(async () => (await panel.locator('.cm-content').innerText()).includes('cambio'), 'recarga trae el cambio externo')
    await page.waitForTimeout(300)
    await setEditor(panel, (await editorText(panel)).replace("x: '1'", "nuevo: '2'"))
    await panel.getByRole('button', { name: 'Guardar' }).click()
    await toast('guardado')
    await until(() => kubectl('-n', 'demo', 'get', 'cm', name, '-o', 'jsonpath={.data.nuevo}') === '2', 'cambio persistido')
    await shot('06-yaml')
    await page.getByRole('button', { name: /Cerrar YAML/ }).click()
  })

  await step('eliminar exige escribir el nombre y borra de verdad', async () => {
    const name = await details().locator('h2').innerText()
    await action('Eliminar')
    const dialog = page.getByRole('dialog')
    if (!(await dialog.locator('button[type=submit]').isDisabled())) throw new Error('Se puede borrar sin confirmar')
    await dialog.getByLabel('Confirmación').fill('otro')
    if (!(await dialog.locator('button[type=submit]').isDisabled())) throw new Error('Acepta un nombre incorrecto')
    await confirmDialog(name, 'Eliminar')
    await until(() => !kubectl('-n', 'demo', 'get', 'cm', '--no-headers').includes(`${name} `), 'borrado en el clúster')
    await details().waitFor({ state: 'detached' })
  })

  await step('eliminación múltiple desde la tabla', async () => {
    await page.getByLabel('Buscar').fill('desde-yaml')
    await until(async () => (await page.getByTestId('row-count').innerText()).startsWith('1'), 'queda 1')
    await page.locator('.grid-row input[type=checkbox]').first().check()
    await page.getByRole('button', { name: 'Eliminar 1' }).click()
    await confirmDialog('1 configmaps', 'Eliminar')
    await until(() => !kubectl('-n', 'demo', 'get', 'cm', '--no-headers').includes('desde-yaml'), 'todos borrados')
    await page.getByLabel('Buscar').fill('')
  })

  await step('CronJob: suspende, reanuda y ejecuta ahora', async () => {
    await sidebar('CronJobs')
    await row('tarea').click()
    await action('Suspender')
    await until(() => kubectl('-n', 'demo', 'get', 'cj', 'tarea', '-o', 'jsonpath={.spec.suspend}') === 'true', 'suspendido')
    await details().locator('.actions .btn', { hasText: 'Reanudar' }).waitFor()
    await action('Reanudar')
    await until(() => kubectl('-n', 'demo', 'get', 'cj', 'tarea', '-o', 'jsonpath={.spec.suspend}') === 'false', 'reanudado')
    await details().locator('.actions .btn', { hasText: 'Suspender' }).waitFor()
    await action('Ejecutar ahora')
    await toast('Job tarea-manual')
    await until(() => kubectl('-n', 'demo', 'get', 'jobs', '--no-headers').includes('tarea-manual'), 'Job creado')
    await details().getByRole('button', { name: 'Cerrar detalles' }).click()
  })

  await step('recursos personalizados: descubre el CRD y usa sus columnas', async () => {
    await page.locator('.side-group', { hasText: 'ejemplo.dev' }).locator('.side-item', { hasText: 'Gadget' }).click()
    await row('rojo').waitFor()
    await page.locator('.grid-head button', { hasText: 'Color' }).waitFor()
    if (!(await row('rojo').innerText()).includes('rojo')) throw new Error('Sin valor de columna')
    await shot('07-crd')
  })

  await step('filtro de varios namespaces: une las listas y muestra la columna Namespace', async () => {
    await selectNamespaces(page, ['demo', 'kube-system'])
    await sidebar('Deployments')
    await row('web').waitFor()
    await row('coredns').waitFor()
    await page.locator('.grid-head button', { hasText: 'Namespace' }).waitFor()
    const summary = await page.getByRole('button', { name: 'Filtro de namespaces' }).innerText()
    if (!summary.includes('demo, kube-system')) throw new Error(`Resumen: ${summary}`)
    // Nada de otros namespaces
    if ((await page.locator('.grid-row', { hasText: 'local-path-provisioner' }).count()) === 0) throw new Error('Falta kube-system')
    await shot('07b-varios-namespaces')
    // «solo» deja uno: la columna desaparece y se filtra al instante
    await page.getByRole('button', { name: 'Filtro de namespaces' }).click()
    await page.getByRole('button', { name: 'Solo demo' }).click({ force: true })
    await until(async () => (await page.locator('.grid-row', { hasText: 'coredns' }).count()) === 0, 'quita kube-system')
    if ((await page.locator('.grid-head button', { hasText: /^Namespace/ }).count()) !== 0) throw new Error('Columna con un solo namespace')
    // Se recuerda entre sesiones como lista
    const saved = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('codycube.namespace.'))?.[1])
    if (saved !== '["demo"]') throw new Error(`Guardado: ${saved}`)
  })

  await step('Node: acordona y deshace, y drena omitiendo DaemonSets', async () => {
    await selectNamespaces(page, [])
    await sidebar('Nodos')
    await page.locator('.grid-row').first().click()
    await action('Acordonar')
    const node = await details().locator('h2').innerText()
    await until(() => kubectl('get', 'node', node, '-o', 'jsonpath={.spec.unschedulable}') === 'true', 'acordonado')
    await details().locator('.actions .btn', { hasText: 'Habilitar' }).waitFor()
    await action('Habilitar')
    await until(() => kubectl('get', 'node', node, '-o', 'jsonpath={.spec.unschedulable}') === '', 'habilitado')
    await details().locator('.actions .btn', { hasText: 'Acordonar' }).waitFor()
    await shot('08-nodo')
    await action('Drenar')
    await confirmDialog(node, 'Drenar')
    await toast('Nodo drenado')
    await until(() => kubectl('get', 'node', node, '-o', 'jsonpath={.spec.unschedulable}') === 'true', 'drenado acordona')
    kubectl('uncordon', node)
    kubectl('-n', 'demo', 'rollout', 'status', 'deploy/web', '--timeout=120s')
    await details().getByRole('button', { name: 'Cerrar detalles' }).click()
  })

  await step('modo solo lectura: el proceso principal bloquea los cambios', async () => {
    await page.getByLabel('Solo lectura').check()
    await sidebar('Deployments')
    await selectNamespaces(page, ['demo'])
    await row('web').click()
    for (const label of ['Escalar', 'Reiniciar', 'Eliminar']) {
      if (!(await details().locator('.actions .btn', { hasText: new RegExp(`^${label}$`) }).isDisabled())) throw new Error(`${label} habilitado`)
    }
    // Aunque la interfaz fallara, el proceso principal debe negarse
    const denied = await page.evaluate(async () => {
      const { contexts } = await window.codycube.invoke('config:list')
      const resource = { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true, verbs: [], shortNames: [], scalable: true }
      const ref = { resource, namespace: 'demo', name: 'web' }
      const attempts = [
        () => window.codycube.invoke('resource:scale', contexts[0].id, ref, 9),
        () => window.codycube.invoke('resource:delete', contexts[0].id, ref, {}),
        () => window.codycube.invoke('exec:start', contexts[0].id, 'demo', 'x', 'y', 80, 24)
      ]
      const messages = []
      for (const attempt of attempts) messages.push(await attempt().then(() => 'PERMITIDO', (e) => e.message))
      return messages
    })
    if (denied.some((m) => !m.includes('solo lectura'))) throw new Error(`Respuestas: ${denied}`)
    if (kubectl('-n', 'demo', 'get', 'deploy', 'web', '-o', 'jsonpath={.spec.replicas}') !== '1') throw new Error('Se escaló en solo lectura')
    await details().getByRole('button', { name: 'Cerrar detalles' }).click()
    await page.getByLabel('Solo lectura').uncheck()
  })

  await step('el puente rechaza métodos desconocidos', async () => {
    const message = await page.evaluate(() => window.codycube.invoke('no:existe').then(() => 'ok', (e) => e.message))
    if (!message.includes('desconocido')) throw new Error(message)
  })

  await step('Helm: instala, muestra valores, actualiza, revierte y desinstala', async () => {
    if (!(await page.evaluate(() => window.codycube.invoke('helm:available')))) throw new Error('helm no está en el PATH de la prueba')
    const chart = mkdtempSync(join(tmpdir(), 'codycube-chart-'))
    mkdirSync(join(chart, 'templates'))
    writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: prueba\nversion: 1.0.0\nappVersion: "1.0"\n')
    writeFileSync(join(chart, 'values.yaml'), 'color: azul\n')
    writeFileSync(join(chart, 'templates/cm.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: {{ .Release.Name }}-cm }\ndata: { color: {{ .Values.color | quote }} }\n')
    const colorInCluster = () => kubectl('-n', 'demo', 'get', 'cm', 'lanzamiento-cm', '-o', 'jsonpath={.data.color}')
    await sidebar('Releases')
    const install = async (values) => {
      await page.getByRole('button', { name: 'Instalar', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Nombre de la release').fill('lanzamiento')
      await dialog.getByLabel('Chart').fill(chart)
      await dialog.locator('textarea').fill(values)
      await dialog.getByRole('button', { name: 'Instalar', exact: true }).click()
      await toast('Release lanzamiento instalada')
    }
    await install('color: rojo\n')
    if (colorInCluster() !== 'rojo') throw new Error('Los valores no se aplicaron')
    await page.locator('.mini tr', { hasText: 'lanzamiento' }).first().click()
    await page.getByRole('button', { name: 'Valores' }).click()
    await page.locator('.code-view', { hasText: 'rojo' }).waitFor()
    await install('color: verde\n')
    await until(() => colorInCluster() === 'verde', 'la actualización se aplica')
    await page.getByRole('button', { name: 'Actualizar' }).click()
    await page.locator('.mini tr', { hasText: 'lanzamiento' }).first().click()
    await page.locator('.helm-detail tr', { hasText: 'superseded' }).waitFor()
    await shot('09-helm')
    await page.locator('.helm-detail tr', { hasText: 'superseded' }).getByRole('button', { name: 'Revertir' }).click()
    await confirmDialog(null, 'Revertir')
    await toast('revertida')
    await until(() => colorInCluster() === 'rojo', 'rollback de helm')
    await page.getByRole('button', { name: 'Desinstalar' }).click()
    await confirmDialog('lanzamiento', 'Desinstalar')
    await page.getByText('No hay releases').waitFor()
    await until(() => !kubectl('-n', 'demo', 'get', 'cm', '--no-headers').includes('lanzamiento'), 'objetos eliminados')
    rmSync(chart, { recursive: true, force: true })
  })

  await step('dos kubeconfig a la vez: conecta ambos clústeres y cambia entre ellos', async () => {
    second = join(mkdtempSync(join(tmpdir(), 'codycube-kc-')), 'otro.yaml')
    copyFileSync(kubeconfig, second)
    execFileSync('kubectl', ['--kubeconfig', second, 'config', 'rename-context', 'codycube-test', 'segundo'])
    await page.evaluate((path) => window.codycube.invoke('config:add-path', path), second)
    await page.reload()
    await page.locator('.context', { hasText: 'segundo' }).getByRole('button', { name: 'Conectar' }).click()
    await page.locator('.cluster-name', { hasText: 'segundo' }).waitFor()
    await page.getByRole('button', { name: 'Clústeres', exact: true }).click()
    await page.locator('.context', { hasText: 'codycube-test' }).getByRole('button', { name: 'Conectar' }).click()
    await page.locator('.cluster-name', { hasText: 'codycube-test' }).waitFor()
    await page.getByRole('button', { name: 'segundo', exact: true }).click()
    await page.locator('.cluster-name', { hasText: 'segundo' }).waitFor()
    if (await page.locator('.cluster-name', { hasText: 'codycube-test' }).isVisible()) throw new Error('Se ven dos clústeres a la vez')
    await page.locator('.hot-wrap').first().hover()
    await page.getByRole('button', { name: 'Desconectar segundo' }).click()
  })

  await step('el inicio se refresca solo si el kubeconfig cambia en disco', async () => {
    execFileSync('kubectl', ['--kubeconfig', second, 'config', 'rename-context', 'segundo', 'renombrado'])
    await page.getByRole('button', { name: 'Clústeres', exact: true }).click()
    await page.locator('.context', { hasText: 'renombrado' }).waitFor({ timeout: 8000 })
    await page.locator('.config-file', { hasText: 'otro.yaml' }).getByRole('button', { name: 'Quitar' }).click()
    await confirmDialog(null, 'Quitar')
    await page.locator('.context', { hasText: 'renombrado' }).waitFor({ state: 'detached' })
  })

  await step('volver al inicio y desconectar', async () => {
    await page.getByRole('button', { name: 'Clústeres', exact: true }).click()
    await page.locator('.context').getByRole('button', { name: 'Abrir' }).waitFor()
    await page.locator('.hot-wrap').first().hover()
    await page.getByRole('button', { name: 'Desconectar codycube-test' }).click()
    await page.locator('.context').getByRole('button', { name: 'Conectar' }).waitFor()
  })

  await step('un servidor caído muestra un error claro al conectar', async () => {
    const text = `apiVersion: v1
kind: Config
current-context: caido
clusters: [{ name: c, cluster: { server: "https://127.0.0.1:9" } }]
contexts: [{ name: caido, context: { cluster: c, user: u } }]
users: [{ name: u, user: { token: x } }]
`
    await page.getByRole('button', { name: 'Pegar texto' }).click()
    await page.getByRole('dialog').locator('textarea').fill(text)
    await page.getByRole('dialog').getByRole('button', { name: 'Cargar' }).click()
    await page.locator('.context', { hasText: 'caido' }).getByRole('button', { name: 'Conectar' }).click()
    await page.locator('.context-error', { hasText: /rechazó|ECONN|unsafe|puerto/i }).waitFor()
  })
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} pasos correctos. Capturas en ${out}`)
  const realErrors = errors.filter((e) => !/Failed to load resource/.test(e))
  if (realErrors.length) console.log(`Errores en la interfaz:\n  ${[...new Set(realErrors)].slice(0, 15).join('\n  ')}`)
  await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
  process.exitCode = failed.length || realErrors.length ? 1 : 0
}
