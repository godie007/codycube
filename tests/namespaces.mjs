// Elige namespaces en el selector múltiple de la barra lateral. Lista vacía: todos.
export async function selectNamespaces(page, names) {
  const button = page.getByRole('button', { name: 'Filtro de namespaces' })
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  const list = page.getByRole('listbox', { name: 'Namespaces' })
  await list.getByRole('checkbox', { name: 'Todos los namespaces' }).check()
  for (const name of names) {
    const box = list.getByRole('checkbox', { name, exact: true })
    // Si el usuario no puede listar namespaces, se escribe el nombre
    await page.getByLabel('Buscar namespace').fill(name)
    if (await box.count()) await box.check()
    else await list.getByRole('button', { name: `+ Añadir «${name}»` }).click()
    await page.getByLabel('Buscar namespace').fill('')
  }
  await page.keyboard.press('Escape')
  await list.waitFor({ state: 'detached' })
}
