import type { StreamParser } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

export interface LanguageDef {
  name: string
  load: () => Promise<Extension>
}

function legacy(name: string, parser: () => Promise<StreamParser<unknown>>): LanguageDef {
  return {
    name,
    load: async () => {
      const [{ StreamLanguage }, p] = await Promise.all([import('@codemirror/language'), parser()])
      return StreamLanguage.define(p)
    }
  }
}

// Language packages are loaded lazily so the editor chunk stays small.
const LANGS: Record<string, LanguageDef> = {
  javascript: { name: 'JavaScript', load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })) },
  typescript: { name: 'TypeScript', load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })) },
  json: { name: 'JSON', load: () => import('@codemirror/lang-json').then((m) => m.json()) },
  python: { name: 'Python', load: () => import('@codemirror/lang-python').then((m) => m.python()) },
  yaml: { name: 'YAML', load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()) },
  markdown: { name: 'Markdown', load: () => import('@codemirror/lang-markdown').then((m) => m.markdown()) },
  shell: legacy('Shell', () => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  powershell: legacy('PowerShell', () => import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell)),
  nginx: legacy('Nginx', () => import('@codemirror/legacy-modes/mode/nginx').then((m) => m.nginx)),
  toml: legacy('TOML', () => import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml)),
  dockerfile: legacy('Dockerfile', () => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile)),
  properties: legacy('Properties', () => import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)),
  xml: legacy('XML', () => import('@codemirror/legacy-modes/mode/xml').then((m) => m.xml)),
  html: legacy('HTML', () => import('@codemirror/legacy-modes/mode/xml').then((m) => m.html)),
  css: legacy('CSS', () => import('@codemirror/legacy-modes/mode/css').then((m) => m.css)),
  scss: legacy('SCSS', () => import('@codemirror/legacy-modes/mode/css').then((m) => m.sCSS)),
  less: legacy('Less', () => import('@codemirror/legacy-modes/mode/css').then((m) => m.less)),
  sql: legacy('SQL', () => import('@codemirror/legacy-modes/mode/sql').then((m) => m.standardSQL)),
  lua: legacy('Lua', () => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
  ruby: legacy('Ruby', () => import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby)),
  go: legacy('Go', () => import('@codemirror/legacy-modes/mode/go').then((m) => m.go)),
  rust: legacy('Rust', () => import('@codemirror/legacy-modes/mode/rust').then((m) => m.rust)),
  perl: legacy('Perl', () => import('@codemirror/legacy-modes/mode/perl').then((m) => m.perl)),
  c: legacy('C', () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.c)),
  cpp: legacy('C++', () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.cpp)),
  java: legacy('Java', () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.java)),
  csharp: legacy('C#', () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp)),
  kotlin: legacy('Kotlin', () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin)),
  scala: legacy('Scala', () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.scala)),
  dart: legacy('Dart', () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.dart)),
  swift: legacy('Swift', () => import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift)),
  r: legacy('R', () => import('@codemirror/legacy-modes/mode/r').then((m) => m.r)),
  groovy: legacy('Groovy', () => import('@codemirror/legacy-modes/mode/groovy').then((m) => m.groovy)),
  cmake: legacy('CMake', () => import('@codemirror/legacy-modes/mode/cmake').then((m) => m.cmake)),
  protobuf: legacy('Protobuf', () => import('@codemirror/legacy-modes/mode/protobuf').then((m) => m.protobuf)),
  diff: legacy('Diff', () => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff)),
  jinja2: legacy('Jinja2', () => import('@codemirror/legacy-modes/mode/jinja2').then((m) => m.jinja2)),
  http: legacy('HTTP', () => import('@codemirror/legacy-modes/mode/http').then((m) => m.http))
}

const BY_EXT: Record<string, string> = {}
const extGroups: [string, string][] = [
  ['javascript', 'js mjs cjs jsx'],
  ['typescript', 'ts mts cts tsx'],
  ['json', 'json jsonc json5 webmanifest har ipynb'],
  ['python', 'py pyw pyi'],
  ['yaml', 'yml yaml'],
  ['markdown', 'md markdown mdx'],
  ['shell', 'sh bash zsh ksh ash bats command'],
  ['powershell', 'ps1 psm1 psd1'],
  ['toml', 'toml'],
  ['properties', 'ini cfg conf cnf properties env service socket timer mount desktop editorconfig'],
  ['xml', 'xml svg xsd xsl xslt plist csproj vbproj fsproj props targets wsdl rss atom'],
  ['html', 'html htm xhtml vue svelte'],
  ['css', 'css'],
  ['scss', 'scss sass'],
  ['less', 'less'],
  ['sql', 'sql'],
  ['lua', 'lua'],
  ['ruby', 'rb gemspec rake'],
  ['go', 'go'],
  ['rust', 'rs'],
  ['perl', 'pl pm'],
  ['c', 'c h'],
  ['cpp', 'cc cpp cxx hpp hh hxx ino'],
  ['java', 'java'],
  ['csharp', 'cs'],
  ['kotlin', 'kt kts'],
  ['scala', 'scala sc'],
  ['dart', 'dart'],
  ['swift', 'swift'],
  ['r', 'r'],
  ['groovy', 'groovy gradle'],
  ['protobuf', 'proto'],
  ['diff', 'diff patch'],
  ['jinja2', 'j2 jinja jinja2']
]
for (const [lang, exts] of extGroups) for (const ext of exts.split(' ')) BY_EXT[ext] = lang

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  'nginx.conf': 'nginx',
  'cmakelists.txt': 'cmake',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_aliases': 'shell',
  '.bash_logout': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  '.zshenv': 'shell',
  '.envrc': 'shell',
  profile: 'shell',
  bashrc: 'shell',
  '.gitconfig': 'properties',
  '.gitmodules': 'properties',
  '.npmrc': 'properties',
  '.env': 'properties',
  'my.cnf': 'properties',
  'cargo.lock': 'toml',
  pipfile: 'toml',
  'poetry.lock': 'toml',
  '.prettierrc': 'json',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  'composer.lock': 'json',
  jenkinsfile: 'groovy',
  gemfile: 'ruby',
  rakefile: 'ruby',
  vagrantfile: 'ruby'
}

/** Picks a CodeMirror language from the file name, its folder (nginx configs) or a shebang line. */
export function detectLanguage(name: string, path: string, content: string): LanguageDef | undefined {
  const lower = name.toLowerCase()
  let id: string | undefined = BY_NAME[lower]
  if (!id && (lower.startsWith('dockerfile') || lower.endsWith('.dockerfile'))) id = 'dockerfile'
  if (!id && lower.startsWith('.env.')) id = 'properties'
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  if (!id && ext === 'conf' && /nginx/i.test(path)) id = 'nginx'
  if (!id && ext) id = BY_EXT[ext]
  if (!id && content.startsWith('#!')) {
    const nl = content.indexOf('\n')
    const line = content.slice(0, nl >= 0 ? Math.min(nl, 200) : 200)
    if (/\b(ba|z|k|da|a)?sh\b/.test(line)) id = 'shell'
    else if (/python/.test(line)) id = 'python'
    else if (/\bnode\b|deno|bun/.test(line)) id = 'javascript'
    else if (/ruby/.test(line)) id = 'ruby'
    else if (/perl/.test(line)) id = 'perl'
    else if (/pwsh|powershell/.test(line)) id = 'powershell'
  }
  return id ? LANGS[id] : undefined
}
