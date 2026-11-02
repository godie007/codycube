// Rasteriza resources/icon.svg a resources/icon.png. Antes: node scripts/brand.mjs
// Uso: npx electron scripts/icon.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const resources = join(__dirname, '..', 'resources')
const svg = readFileSync(join(resources, 'icon.svg'))

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  const html = `<!doctype html><body style="margin:0;background:transparent"><img width="1024" height="1024" src="data:image/svg+xml;base64,${svg.toString('base64')}"></body>`
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  await new Promise((done) => setTimeout(done, 800))
  const image = await win.webContents.capturePage()
  writeFileSync(join(resources, 'icon.png'), image.resize({ width: 1024, height: 1024 }).toPNG())
  app.quit()
})
