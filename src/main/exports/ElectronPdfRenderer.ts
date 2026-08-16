import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import type { PdfRenderer } from './ExportService'

/**
 * Prints study notes through Chromium, which Electron already ships, rather
 * than adding a PDF library. The page is written to a private temporary file
 * because printToPDF needs a loaded document, and it is rendered with scripting
 * disabled: the notes are static markup and nothing in them should execute.
 */
export class ElectronPdfRenderer implements PdfRenderer {
  async render(html: string): Promise<Uint8Array> {
    const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-pdf-'))
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        javascript: false
      }
    })
    try {
      const page = join(directory, 'notes.html')
      await writeFile(page, html, { encoding: 'utf8', mode: 0o600 })
      await window.loadFile(page)
      return await window.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        generateDocumentOutline: true
      })
    } finally {
      window.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  }
}
