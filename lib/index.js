/**
 * dsh-plugin-sections
 *
 * 把 DSH 自己那几节提示文本换成自己的版本。
 *
 * 原理只有一个:system prompt 的节按名字区分,注册一个同名的就把原来那节顶掉。
 * 命中的节写在 prompts/dsh-sections-zh.txt,按【节名 · 标题】分块。
 *
 * 分两层注册,因为来源不同:
 *   全局层    —— app:web-surface / harness:source 这类,全局注册的同名即可顶掉。
 *   agent 层  —— team:policy / ui:deliverable-file-references / deployment:persona-prefix
 *                这几个是在 agent 自己的 system-prompt 实例里注册的,全局层看到的是空的那份。
 *                要顶掉只能在那个 agent 的 ctx 上注册同名,所以在 agent/created 时挂。
 *
 * 老会话的 agent 早于插件创建,agent/created 不会补发 —— 用 /dsh-sec/apply-agent?sid= 手动挂一次。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-plugin-sections'
export const inject = ['systemPrompt', 'webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_FILE = path.join(HERE, '..', 'prompts', 'dsh-sections-zh.txt')

/** 各节在 system prompt 里的位置,照 DSH 自己的 SECTION_ORDERS 抄。 */
const ORDERS = {
  'team:policy': 600,
  'ui:deliverable-file-references': 9000,
  'harness:source': 10000,
  'app:web-surface': 10100,
  'deployment:persona-prefix': 0,
}

/** 这几节要挂到 agent 自己的 ctx 上,全局层顶不掉。 */
const AGENT_LEVEL = new Set([
  'team:policy',
  'ui:deliverable-file-references',
  'deployment:persona-prefix',
])

/** 文件里没有名字、但需要清空的节。 */
const BLANKS = {
  'deployment:persona-prefix': 0,
}

export function apply(ctx) {
  const file = DEFAULT_FILE
  const report = { file, applied: [], failed: [], skipped: [] }
  const agentDisposers = new WeakMap()
  let items = []

  function parse(text) {
    const out = []
    const seen = new Set()
    for (const block of String(text || '').split('【')) {
      if (!block.trim()) continue
      const end = block.indexOf('】')
      if (end < 0) continue
      const header = block.slice(0, end)
      const body = block.slice(end + 1).trim()
      const sectionName = header.split('·')[0].trim()
      if (!Object.prototype.hasOwnProperty.call(ORDERS, sectionName)) {
        if (sectionName && !seen.has(sectionName)) {
          seen.add(sectionName)
          report.skipped.push(sectionName)
        }
        continue
      }
      if (!body) continue
      out.push({ name: sectionName, order: ORDERS[sectionName], text: body })
    }
    return out
  }

  function applyGlobal() {
    report.applied = []
    report.failed = []
    report.skipped = []
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch (e) {
      report.failed.push('读不到文件: ' + String((e && e.message) || e))
      return
    }
    items = parse(raw)
    for (const item of items) {
      if (AGENT_LEVEL.has(item.name)) continue
      try {
        ctx.systemPrompt.section({ name: item.name, order: item.order, text: item.text })
        report.applied.push(item.name + ' (' + item.text.length + ' 字)')
      } catch (e) {
        report.failed.push(item.name + ': ' + String((e && e.message) || e))
      }
    }
  }

  function applyForAgent(agent) {
    if (!agent) return
    let actx
    try {
      actx = agent.ctx
    } catch {
      actx = undefined
    }
    if (!actx || !actx.systemPrompt || typeof actx.systemPrompt.section !== 'function') {
      if (!report.failed.some((x) => x.startsWith('agent ctx'))) {
        report.failed.push('agent ctx: 这个 agent 没有可用的 ctx.systemPrompt')
      }
      return
    }
    let held = agentDisposers.get(agent)
    if (held && held.length) {
      // 已经挂过了。再挂一次会被 DSH 判成同层重复注册,所以直接跳过。
      const tag = 'agent 已挂过 (' + held.length + ' 节)'
      if (!report.applied.includes(tag)) report.applied.push(tag)
      return
    }
    if (!held) {
      held = []
      agentDisposers.set(agent, held)
    }
    for (const [sectionName, order] of Object.entries(BLANKS)) {
      try {
        held.push(actx.systemPrompt.section({ name: sectionName, order, text: '' }))
        const tag = sectionName + ' (agent 层清空)'
        if (!report.applied.includes(tag)) report.applied.push(tag)
      } catch (e) {
        const tag = sectionName + ' (agent 层清空): ' + String((e && e.message) || e)
        if (!report.failed.some((x) => x.startsWith(sectionName + ' (agent 层清空)'))) report.failed.push(tag)
      }
    }
    for (const item of items) {
      if (!AGENT_LEVEL.has(item.name)) continue
      if (Object.prototype.hasOwnProperty.call(BLANKS, item.name)) continue
      try {
        held.push(actx.systemPrompt.section({ name: item.name, order: item.order, text: item.text }))
        const tag = item.name + ' (agent 层, ' + item.text.length + ' 字)'
        if (!report.applied.includes(tag)) report.applied.push(tag)
      } catch (e) {
        const tag = item.name + ' (agent 层): ' + String((e && e.message) || e)
        if (!report.failed.some((x) => x.startsWith(item.name + ' (agent 层)'))) report.failed.push(tag)
      }
    }
  }

  applyGlobal()

  // ---------- 工具说明改写 ----------
  //
  // 工具说明不在"节"里,注册同名也顶不掉。它在装配结果的 assembly.tools 里。
  // 所以换个做法:把 systemPrompt.assemble 包一层 —— 让它照常装完,拿到成品,
  // 把每条工具的 description 换成自己写的,再交回去。
  // 只换叙述;工具名、参数名、必填、类型一律不动,字典里没有的工具原样返回。
  const TOOL_DICT_FILE = path.join(HERE, '..', 'prompts', 'tools-zh.json')
  let toolDict = {}
  let toolDictError = ''
  try {
    toolDict = JSON.parse(readFileSync(TOOL_DICT_FILE, 'utf8'))
  } catch (e) {
    toolDictError = String((e && e.message) || e)
  }

  const toolReport = { dict: Object.keys(toolDict).length, rewritten: 0, unknown: [], lastAt: 0 }

  function rewriteTools(assembly) {
    const list = assembly && Array.isArray(assembly.tools) ? assembly.tools : null
    if (!list) return
    let hit = 0
    const missing = []
    for (const tool of list) {
      if (!tool || typeof tool.name !== 'string') continue
      const text = toolDict[tool.name]
      if (typeof text === 'string' && text) {
        tool.description = text
        hit += 1
      } else {
        missing.push(tool.name)
      }
    }
    toolReport.rewritten = hit
    toolReport.unknown = missing.slice(0, 40)
    toolReport.lastAt = Date.now()
  }

  const originalAssemble = ctx.systemPrompt.assemble
  if (typeof originalAssemble === 'function') {
    ctx.systemPrompt.assemble = async function patchedAssemble(...args) {
      const assembly = await originalAssemble.apply(this, args)
      try {
        rewriteTools(assembly)
      } catch (e) {
        ctx.logger.warn('dsh-plugin-sections: 工具说明改写失败: ' + String((e && e.message) || e))
      }
      return assembly
    }
  } else {
    report.failed.push('assemble: 拿不到 systemPrompt.assemble')
  }

  // ---------- 运行时上下文:模板 + 实时值 ----------
  //
  // 这几条不是节,是 context。文本每次按当时状态现写,所以覆写时给的是函数:
  // 句子是布洛妮娅的口吻,数值取当时的。取不到就退回 DSH 原来的写法,
  // 宁可不好听,也不能把工作目录这类事实写错。
  const contextProbe = {}

  function pickString(...cands) {
    for (const v of cands) {
      if (typeof v === 'string' && v.trim()) return v
    }
    return ''
  }

  function scopeOf(context) {
    const sc = context && context.scope
    return sc && typeof sc === 'object' ? sc : null
  }

  function cwdOf(context) {
    const sc = scopeOf(context)
    if (!sc) return ''
    const value = pickString(
      sc.cwd,
      sc.workingDirectory,
      sc.session && sc.session.cwd,
      sc.session && sc.session.header && sc.session.header.cwd,
      sc.session && sc.session.meta && sc.session.meta.cwd,
    )
    if (!value) {
      // 记一次探针,方便事后知道该往上哪儿取。
      contextProbe.cwdKeys = Object.keys(sc).slice(0, 40)
      contextProbe.cwdSessionKeys = sc.session ? Object.keys(sc.session).slice(0, 40) : []
    }
    return value
  }

  function registerContext(name, order, text) {
    try {
      const off = ctx.systemPrompt.context({ name, order, text })
      report.applied.push('context ' + name)
      return off
    } catch (e) {
      const msg = String((e && e.message) || e)
      report.failed.push('context ' + name + ': ' + msg)
      if (/already registered/i.test(msg)) contextProbe.needsAgentLevel = true
      return null
    }
  }

  const offCwd = registerContext('working-directory', 100, (context) => {
    const cwd = cwdOf(context)
    if (!cwd) return ''
    return '布洛妮娅现在的工作目录是 ' + JSON.stringify(cwd) + '。要换目录用 cd，别在别处瞎猜路径。'
  })

  ctx.on('agent/created', (payload) => {
    try {
      applyForAgent(payload && payload.agent)
    } catch (e) {
      ctx.logger.warn('dsh-plugin-sections: agent 挂载失败: ' + String((e && e.message) || e))
    }
  })

  // ---------- HTTP ----------
  function sendJson(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(data))
  }

  function query(req) {
    try {
      return new URL(req.url || '/', 'http://x').searchParams
    } catch {
      return new URLSearchParams()
    }
  }

  const disposers = []
  function route(routePath, handler) {
    try {
      disposers.push(ctx.webServer.register({ kind: 'exact', path: routePath, handler }))
    } catch (e) {
      ctx.logger.warn('dsh-plugin-sections: 路由 ' + routePath + ' 没装上: ' + String((e && e.message) || e))
    }
  }

  // 探针:取值到底从哪儿来。工作目录没取到时,这里能看到 scope 上有哪些字段。
  route('/dsh-sec/probe', (req, res) => {
    const sid = query(req).get('sid') || ''
    let agent
    try {
      const agents = ctx.get('agents')
      agent = agents && typeof agents.get === 'function' ? agents.get(sid) : undefined
    } catch {
      agent = undefined
    }
    const shape = {}
    if (agent) {
      shape.agentKeys = Object.keys(agent).slice(0, 60)
      if (agent.session) shape.sessionKeys = Object.keys(agent.session).slice(0, 60)
    }
    sendJson(res, 200, { ok: true, sid, probe: contextProbe, shape })
  })

  // 工具说明改写的现状:字典几条、这次改了几条、哪些工具字典里没有。
  route('/dsh-sec/tools', (req, res) => {
    const want = query(req).get('name')
    const sample = want && toolDict[want] ? { name: want, description: toolDict[want] } : undefined
    sendJson(res, 200, {
      ok: true,
      dictFile: TOOL_DICT_FILE,
      dictError: toolDictError || undefined,
      ...toolReport,
      counts: {
        dict: Object.keys(toolDict).length,
        rewritten: toolReport.rewritten,
        unknown: toolReport.unknown.length,
      },
      sample,
    })
  })

  route('/dsh-sec/state', (req, res) => {
    const params = query(req)
    if (params.get('reload') === '1') {
      try {
        applyGlobal()
      } catch (e) {
        report.failed.push(String((e && e.message) || e))
      }
    }
    sendJson(res, 200, { ok: true, ...report })
  })

  route('/dsh-sec/apply-agent', (req, res) => {
    const sid = query(req).get('sid') || ''
    if (!sid) return sendJson(res, 400, { ok: false, error: 'sid required' })
    let agent
    try {
      const agents = ctx.get('agents')
      agent = agents && typeof agents.get === 'function' ? agents.get(sid) : undefined
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'agents 取不到: ' + String((e && e.message) || e) })
    }
    if (!agent) return sendJson(res, 404, { ok: false, error: '这个 sid 没有活着的 agent: ' + sid })
    try {
      applyForAgent(agent)
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
    sendJson(res, 200, { ok: true, sid, ...report })
  })

  return () => {
    try {
      if (typeof originalAssemble === 'function') ctx.systemPrompt.assemble = originalAssemble
    } catch {
      /* ignore */
    }
    try {
      if (typeof offCwd === 'function') offCwd()
    } catch {
      /* ignore */
    }
    for (const off of disposers) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
  }
}
