// Comprueba que el binario de Electron esté utilizable y lo repara si falta.
// El postinstall del paquete `electron` debería hacerlo, pero se salta con --ignore-scripts,
// al restaurar un node_modules copiado o si la descarga se corta: entonces `electron-vite`
// falla con "Electron uninstall" porque no hay path.txt. Esto lo arregla en el siguiente install.
// Si `dist/` ya está completo solo reescribe path.txt (install.js volvería a descomprimir el zip
// y en Windows falla si una instancia abierta tiene bloqueado algún .dll). Sin dist, descarga:
// si el zip está en la caché de la máquina, no usa red.
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const dir = join(__dirname, '..', 'node_modules', 'electron')
if (!existsSync(dir)) process.exit(0) // sin dependencias instaladas, nada que revisar

// Mismo nombre de ejecutable que usa install.js dentro de dist/.
const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform
const MAC = 'Electron.app/Contents/MacOS/Electron'
const exec = platform === 'darwin' || platform === 'mas' ? MAC : platform === 'win32' ? 'electron.exe' : 'electron'
const execPath = join(dir, 'dist', exec)

// Caso 1: el binario no está. Lo descarga (o lo saca de la caché) install.js.
if (!existsSync(execPath)) {
  console.log('Electron: falta el binario, instalándolo…')
  const install = spawnSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit' })
  if (install.status !== 0) {
    console.error(
      'Electron: no se pudo instalar. Si la app está abierta, ciérrala y reintenta con' +
        ' `node node_modules/electron/install.js`.'
    )
    process.exit(install.status ?? 1)
  }
  process.exit(0)
}

// Caso 2: el binario está, pero falta path.txt (o apunta a otro sitio) porque se interrumpió
// la instalación. Basta con reescribirlo; no hace falta volver a descomprimir nada.
const pathFile = join(dir, 'path.txt')
const current = existsSync(pathFile) ? readFileSync(pathFile, 'utf8') : ''
if (current.trim() !== exec) writeFileSync(pathFile, exec)
