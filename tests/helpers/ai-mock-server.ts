import { createServer, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'

/**
 * A minimal OpenAI-compatible chat server for the README screenshots: it answers
 * `/v1/models` and `/v1/chat/completions` with a scripted agent conversation
 * (two tool calls, then a summary). The script position is derived from the
 * request itself — the number of `tool` messages in the history — so the mock
 * stays stateless. The reply language follows the user message (CJK → Chinese).
 */

const DF = `Filesystem      Size  Used Avail Use% Mounted on
/dev/vda1        99G   38G   56G  41% /
tmpfs           3.9G     0  3.9G   0% /dev/shm
/dev/vdb1       197G  121G   66G  65% /data`

const FREE = `               total        used        free      shared  buff/cache   available
Mem:           7.8Gi       3.2Gi       812Mi       210Mi       3.8Gi       4.1Gi
Swap:             0B          0B          0B`

/** Output the fake `df -h /` / `free -m` commands return (wired via the test SSH server's execHandler). */
export const AI_FAKE_COMMANDS: Record<string, string> = { 'df -h /': DF, 'free -m': FREE }

export interface AiMock {
  /** Bare base URL (no /v1): the app's OpenAI-protocol normalization appends it. */
  baseUrl: string
  close(): Promise<void>
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sse(res: ServerResponse, chunks: string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const chunk of chunks) res.write(chunk)
  res.end()
}

const textChunk = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
const callChunk = (id: string, name: string, args: Record<string, unknown>): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] })}\n\n` +
  // The outer JSON.stringify already escapes the args object once — a second level here
  // would double-encode it into a string and the app would see no command.
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] })}\n\n`
const endTool = 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
const endStop = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
const DONE = 'data: [DONE]\n\n'

interface ScriptCall {
  text: string
  callId: string
  args: Record<string, unknown>
}

interface LangScript {
  turn1: ScriptCall
  turn2: ScriptCall
  /** Final summary chunks (no tool call). */
  turn3: string[]
}

const SCRIPT: Record<'zh' | 'en', LangScript> = {
  zh: {
    turn1: { text: '好的，我先看看磁盘使用情况。', callId: 'call_df', args: { command: 'df -h /' } },
    turn2: { text: '磁盘没问题，再确认一下内存。', callId: 'call_free', args: { command: 'free -m' } },
    turn3: [
      '检查完成 ✅\n\n',
      '- **磁盘**：`/` 已用 **38G / 99G**（41%），`/data` 用了 65%\n',
      '- **内存**：7.8G 已用 **3.2G**，还有 4.1G 可用\n\n',
      '整体状态健康，暂时不需要清理。'
    ]
  },
  en: {
    turn1: { text: 'Sure — checking the disk usage first.', callId: 'call_df', args: { command: 'df -h /' } },
    turn2: { text: 'Disk looks fine, now the memory.', callId: 'call_free', args: { command: 'free -m' } },
    turn3: [
      'Check complete ✅\n\n',
      '- **Disk**: `/` at **38G / 99G** (41%), `/data` at 65%\n',
      '- **Memory**: **3.2G** of 7.8G used, 4.1G available\n\n',
      'Everything looks healthy — no cleanup needed.'
    ]
  }
}

export function startAiMock(): Promise<AiMock> {
  const server: Server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url === '/v1/models') {
      return json(res, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })
    }
    if (req.method !== 'POST' || url !== '/v1/chat/completions') {
      res.writeHead(404)
      return res.end('{}')
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let messages: any[]
      try {
        messages = JSON.parse(body).messages ?? []
      } catch {
        messages = []
      }
      const users = messages.filter((m) => m.role === 'user')
      const lastUser = String(users[users.length - 1]?.content ?? '')
      const lang = /[\u4e00-\u9fff]/.test(lastUser) ? 'zh' : 'en'
      const turn = messages.filter((m) => m.role === 'tool').length
      const s = SCRIPT[lang]
      if (turn === 0) return sse(res, [textChunk(s.turn1.text), callChunk(s.turn1.callId, 'run_command', s.turn1.args), endTool, DONE])
      if (turn === 1) return sse(res, [textChunk(s.turn2.text), callChunk(s.turn2.callId, 'run_command', s.turn2.args), endTool, DONE])
      return sse(res, [...s.turn3.map(textChunk), endStop, DONE])
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}
