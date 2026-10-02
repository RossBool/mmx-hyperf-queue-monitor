#!/usr/bin/env node
/**
 * 把 public/ 下的二进制资源转成 base64 data URI 的 TS 模块。
 *
 * 背景：GitHub API 的 push_files 传输层对二进制内容会**静默丢弃**——
 * commit 能建成、文件不进树、全程不报错。排查这个问题时踩过坑，
 * 所以改为把必须保留的二进制资源内联进源码。
 *
 * 用法：node scripts/inline-binary-assets.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {{ src: string, out: string, mime: string, doc: string }[]} */
const ASSETS = [
  {
    src: 'public/placeholder.webp',
    out: 'src/assets/placeholder.webp.ts',
    mime: 'image/webp',
    doc: '登录页占位图',
  },
  // robot.png 无任何引用（ai-talk 演示页删除后遗留），故不内联。
]

for (const a of ASSETS) {
  const abs = resolve(root, a.src)
  const buf = readFileSync(abs)
  const uri = `data:${a.mime};base64,${buf.toString('base64')}`

  const content = `/**
 * 内联资源：${a.doc}
 *
 * \`${a.src}\` 原本是二进制文件，GitHub API 的 push_files 传输层
 * 对二进制内容会**静默丢弃**（commit 建成、文件不进树、不报错），因此改为
 * 以 base64 data URI 形式内联，保证克隆仓库后页面渲染完整。
 *
 * 原始文件：${a.src}（${buf.length} 字节，${a.mime}）
 * 生成方式：node scripts/inline-binary-assets.mjs
 */
export const PLACEHOLDER_IMAGE_URI = '${uri}'
`

  const outAbs = resolve(root, a.out)
  mkdirSync(dirname(outAbs), { recursive: true })
  writeFileSync(outAbs, content)
  console.log(`✓ ${a.src} (${buf.length} B) → ${a.out} (${(content.length / 1024).toFixed(1)} KB)`)
}
