import { strFromU8, unzipSync } from 'fflate'
import type { BookRecord, ChapterRecord } from './types'

interface EpubFileMap {
  [path: string]: Uint8Array
}

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

function xmlDocument(input: string): Document {
  const document = new DOMParser().parseFromString(input, 'application/xml')
  if (document.querySelector('parsererror')) throw new Error('EPUB 内部 XML 文件格式错误')
  return document
}

function elementText(document: Document, names: string[]): string {
  for (const name of names) {
    const element = document.getElementsByTagName(name)[0]
    if (element?.textContent?.trim()) return element.textContent.trim()
  }
  return ''
}

function normalizePath(path: string): string {
  const output: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') output.pop()
    else output.push(part)
  }
  return output.join('/')
}

function resolvePath(basePath: string, href: string): string {
  const cleanHref = decodeURIComponent(href.split('#')[0].split('?')[0])
  return normalizePath(`${basePath ? `${basePath}/` : ''}${cleanHref}`)
}

function textFromXhtml(input: string): { title: string; text: string } {
  const document = new DOMParser().parseFromString(input, 'text/html')
  document.querySelectorAll('script,style,noscript,svg,nav').forEach((node) => node.remove())
  const title = document.querySelector('h1,h2,h3,h4')?.textContent?.trim()
    || document.querySelector('title')?.textContent?.trim()
    || ''
  const blocks = Array.from(document.body.querySelectorAll('h1,h2,h3,h4,h5,p,blockquote,pre,li'))
    .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const text = (blocks.length > 0 ? blocks : [(document.body.textContent ?? '').replace(/\s+/g, ' ').trim()])
    .filter(Boolean)
    .join('\n\n')
  return { title, text }
}

function fileText(files: EpubFileMap, path: string): string {
  const bytes = files[path]
  if (!bytes) throw new Error(`EPUB 缺少文件：${path}`)
  return strFromU8(bytes)
}

export async function parseEpub(file: File): Promise<{ book: BookRecord; chapters: ChapterRecord[] }> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer())) as EpubFileMap
  const container = xmlDocument(fileText(files, 'META-INF/container.xml'))
  const rootfileValue = container.getElementsByTagName('rootfile')[0]?.getAttribute('full-path')
  const rootfile = rootfileValue ? normalizePath(decodeURIComponent(rootfileValue)) : undefined
  if (!rootfile) throw new Error('EPUB 找不到 OPF 书籍目录')

  const opf = xmlDocument(fileText(files, rootfile))
  const opfDirectory = rootfile.includes('/') ? rootfile.slice(0, rootfile.lastIndexOf('/')) : ''
  const manifest = new Map<string, ManifestItem>()
  Array.from(opf.getElementsByTagName('item')).forEach((item) => {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    if (id && href) manifest.set(id, {
      id,
      href: resolvePath(opfDirectory, href),
      mediaType: item.getAttribute('media-type') ?? '',
      properties: item.getAttribute('properties') ?? '',
    })
  })

  const spine = Array.from(opf.getElementsByTagName('itemref'))
    .map((itemref) => manifest.get(itemref.getAttribute('idref') ?? ''))
    .filter((item): item is ManifestItem => Boolean(item))
  const orderedItems = spine.length > 0 ? spine : [...manifest.values()]
  const chapters: ChapterRecord[] = []
  const title = elementText(opf, ['dc:title', 'title']) || file.name.replace(/\.epub$/i, '')
  for (const item of orderedItems) {
    if (!/application\/(xhtml\+xml|xhtml)|text\/html/i.test(item.mediaType) || /(^|\s)(nav|cover)(\s|$)/i.test(item.properties)) continue
    const parsed = textFromXhtml(fileText(files, item.href))
    if (!parsed.text) continue
    chapters.push({
      id: crypto.randomUUID(),
      bookId: '',
      index: chapters.length,
      title: parsed.title || `第 ${chapters.length + 1} 章`,
      text: parsed.text,
    })
  }
  if (chapters.length === 0) throw new Error('EPUB 中没有找到可阅读的 XHTML/HTML 正文')

  const book: BookRecord = {
    id: crypto.randomUUID(),
    title,
    sourceName: file.name,
    sourceSize: file.size,
    chapterCount: chapters.length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentChapter: 0,
    currentOffset: 0,
  }
  chapters.forEach((chapter) => { chapter.bookId = book.id })
  return { book, chapters }
}
