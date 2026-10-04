/** 启发式 PHP 结构校验：剥离注释与字符串后检查括号平衡 + 语法要素。 */
import fs from 'node:fs'
let bad = 0, n = 0
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, 'utf8'); n++
  const clean = src
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/<<<'?SQL'?[\s\S]*?^SQL$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  const c = (ch) => [...clean].filter(x => x === ch).length
  const d = { '{}': c('{') - c('}'), '()': c('(') - c(')'), '[]': c('[') - c(']') }
  const issues = []
  if (d['{}'] || d['()'] || d['[]']) issues.push(`括号 ${JSON.stringify(d)}`)
  if (!/^<\?php/.test(src)) issues.push('缺 <?php')
  if ((src.match(/^<\?php/gm) || []).length > 1) issues.push('多个 <?php')
  if (issues.length) { bad++; console.log(`  ✗ ${f}: ${issues.join(' / ')}`) }
}
console.log(bad === 0 ? `  ✓ ${n} 个 PHP 文件结构通过` : `  ✗ ${bad}/${n} 个文件有问题`)
process.exit(bad ? 1 : 0)
