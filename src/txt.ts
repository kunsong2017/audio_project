import type { BookRecord, ChapterRecord } from './types'

const chapterPattern = /^(第[0-9零一二三四五六七八九十百千万两]{1,16}[章节回卷集部篇].{0,80}|番外.{0,80}|序章.{0,80}|楔子.{0,80})$/

function cleanLine(line: string): string {
  return line.replace(/^\uFEFF/, '').trim()
}

export function parseTxt(title: string, sourceName: string, sourceSize: number, input: string): { book: BookRecord; chapters: ChapterRecord[] } {
  const lines = input.replace(/\r\n?/g, '\n').split('\n').map(cleanLine)
  const headings: { index: number; title: string }[] = []
  lines.forEach((line, index) => {
    if (line.length > 0 && chapterPattern.test(line)) headings.push({ index, title: line })
  })
  const starts = headings.length > 0 ? headings : [{ index: 0, title: '全文' }]
  const chapters = starts.map((heading, chapterIndex) => {
    const end = starts[chapterIndex + 1]?.index ?? lines.length
    const content = lines.slice(heading.index + (headings.length > 0 ? 1 : 0), end).join('\n').trim()
    return {
      id: crypto.randomUUID(), bookId: '', index: chapterIndex, title: heading.title,
      text: content || '（本章没有可朗读文本）',
    }
  })
  const book: BookRecord = {
    id: crypto.randomUUID(), title: title || sourceName.replace(/\.txt$/i, ''), sourceName, sourceSize,
    chapterCount: chapters.length, createdAt: Date.now(), updatedAt: Date.now(), currentChapter: 0, currentOffset: 0,
  }
  chapters.forEach((chapter) => { chapter.bookId = book.id })
  return { book, chapters }
}
