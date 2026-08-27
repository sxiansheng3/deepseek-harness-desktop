import { readFile, writeFile } from 'node:fs/promises'
import pngToIco from 'png-to-ico'

const source = new URL('../build/icon-1024.png', import.meta.url)
const destination = new URL('../build/icon.ico', import.meta.url)
const png = await readFile(source)
const icon = await pngToIco(png)
await writeFile(destination, icon)
