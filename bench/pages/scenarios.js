// SPDX-License-Identifier: MIT
//
// Benchmark scenarios. This module runs inside the page, next to the build under test, and
// exposes window.__bench = { list(), run(name, opts) }. The runner (ypy bench) opens a
// fresh page per scenario and round, so no scenario inherits the JIT or heap state of another.
//
// Only the public API is used (ypy.ajax, ypy.process, ypy.trigger) plus the extension API that
// registerExtension hands to init(): that API stays reachable in the minified and in the
// unminified build alike, and it is the surface extensions depend on anyway. A scenario that
// needs a function the build does not have reports `skipped` instead of failing the run.
//
// Every scenario returns { metrics: { <id>: { unit, samples: number[] } } }. Times are script
// time only: no layout or paint is forced, so what is measured is the cost of YPY itself.

import * as fx from './fixtures.js'

const Y = window.ypy
const mount = document.getElementById('mount')
let API = null

try {
  Y.registerExtension?.('bench', { init (api) { API = api } })
} catch { /* the build has no extension API; scenarios that need it are skipped */ }

// ---- fake server: window.fetch answers from a table, so no network noise ----

const responses = new Map()
const setResponse = (path, text, status = 200) => responses.set(path, { text, status })
window.fetch = async (url) => {
  const entry = responses.get(String(url)) ?? { text: '', status: 200 }
  return new Response(entry.status === 204 ? null : entry.text, { status: entry.status, headers: { 'Content-Type': 'text/html' } })
}

const go = (path, options) => Y.ajax('GET', path, options)
const byId = id => document.getElementById(id)
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
const reset = () => { mount.replaceChildren() }

class Skip extends Error {}
const need = (cond, what) => { if (!cond) throw new Skip(what) }

// ---- measuring helpers ----

/** Total warm-up operations before sampling, so the hot paths are optimized when measured. */
const WARMUP_OPS = 150

function plan (opts, reps, ops) {
  const scale = opts.scale ?? 1
  return {
    reps: Math.max(5, Math.round(reps * scale)),
    ops,
    warmup: Math.min(12, Math.max(3, Math.ceil(WARMUP_OPS / ops)))
  }
}

/** Samples of the average time of `ops` async operations, in milliseconds. */
async function sampleAsync (fn, { reps, ops, warmup }, unit = 'ms') {
  const out = []
  let counter = 0
  for (let r = -warmup; r < reps; r++) {
    const t0 = performance.now()
    for (let k = 0; k < ops; k++) await fn(counter++)
    const dt = (performance.now() - t0) / ops
    if (r >= 0) out.push(unit === 'us' ? dt * 1000 : dt)
  }
  return out
}

/** Same for synchronous operations. */
function sampleSync (fn, { reps, ops, warmup }, unit = 'ms') {
  const out = []
  let counter = 0
  for (let r = -warmup; r < reps; r++) {
    const t0 = performance.now()
    for (let k = 0; k < ops; k++) fn(counter++)
    const dt = (performance.now() - t0) / ops
    if (r >= 0) out.push(unit === 'us' ? dt * 1000 : dt)
  }
  return out
}

const one = (id, unit, samples) => ({ metrics: { [id]: { unit, samples } } })

// ---- swap ----

function swapScenario (style, n, kind) {
  const ops = n >= 1000 ? 1 : n >= 100 ? 4 : 20
  const reps = n >= 1000 ? 16 : n >= 100 ? 24 : 20
  return async opts => {
    mount.innerHTML = `<div id="host"><ul id="list">${fx.innerList(n, kind, 0)}</ul></div>`
    const inner = style === 'innerHTML'
    for (const v of [0, 1]) {
      setResponse('/r/' + v, inner ? fx.innerList(n, kind, v + 1) : fx.outerList(n, kind, v + 1))
    }
    const samples = await sampleAsync(i => go('/r/' + (i & 1), { target: byId('list'), swap: style }), plan(opts, reps, ops))
    reset()
    return one(`swap.${kind === 'wired' ? '' : kind + '.'}${style}.${n}`, 'ms', samples)
  }
}

// ---- morph ----

function morphScenario (style, n, noop = false) {
  const ops = n >= 1000 ? 1 : n >= 100 ? 5 : 20
  const reps = n >= 1000 ? 16 : n >= 100 ? 24 : 20
  return async opts => {
    mount.innerHTML = `<div id="host"><ul id="list">${fx.morphRows(n, 0)}</ul></div>`
    const inner = style === 'innerMorph'
    const render = v => inner ? fx.morphRows(n, v) : fx.morphOuter(n, v)
    setResponse('/m/0', render(0))
    setResponse('/m/1', render(noop ? 0 : 1))
    // the user is typing in row 2: the morph has to keep the focus, the value and the selection
    const input = byId('in-2')
    input.focus()
    input.value = 'typed'
    input.setSelectionRange(1, 3)
    let focusLost = 0, valueLost = 0, selectionLost = 0, total = 0
    const samples = await sampleAsync(async i => {
      // alternate A -> B -> A; a no-op morph always sends A
      await go('/m/' + (noop ? 0 : (i + 1) & 1), { target: byId('list'), swap: style })
      const active = document.activeElement
      total++
      if (active?.id !== 'in-2') { focusLost++; byId('in-2').focus(); return }
      if (active.value !== 'typed') valueLost++
      if (active.selectionStart !== 1 || active.selectionEnd !== 3) selectionLost++
    }, plan(opts, reps, ops))
    reset()
    const id = `morph.${inner ? 'inner' : 'outer'}${noop ? '.noop' : ''}.${n}`
    return {
      metrics: {
        [id]: { unit: 'ms', samples },
        [`${id}.preserve_failures`]: { unit: 'count', samples: [focusLost + valueLost + selectionLost] }
      },
      note: `focus kept ${total - focusLost}/${total}, value kept ${total - valueLost}/${total}, selection kept ${total - selectionLost}/${total}`
    }
  }
}

// ---- process() ----

function processScenario (id, build, reps) {
  return async opts => {
    need(typeof Y.process === 'function', 'ypy.process')
    const html = build()
    const p = plan(opts, reps, 1)
    const samples = []
    for (let r = -Math.min(p.warmup, 4); r < p.reps; r++) {
      mount.innerHTML = html
      const t0 = performance.now()
      Y.process(mount)
      const dt = performance.now() - t0
      if (r >= 0) samples.push(dt)
      reset()
    }
    return one(id, 'ms', samples)
  }
}

// ---- attribute reads ----

function attrScenario (id, setup, { reads = 2000, config } = {}) {
  return async opts => {
    need(API?.attributeValue, 'attributeValue in the extension API')
    mount.innerHTML = setup()
    const leaf = byId('leaf')
    const saved = {}
    for (const key in config) { saved[key] = Y.config[key]; Y.config[key] = config[key] }
    try {
      const names = ['ypy-target', 'ypy-swap', 'ypy-vals', 'ypy-headers']
      const read = i => API.attributeValue(leaf, names[i & 3])
      const samples = sampleSync(read, plan(opts, 24, reads), 'us')
      return one(id, 'us', samples)
    } finally {
      Object.assign(Y.config, saved)
      reset()
    }
  }
}

function attrOneScenario (id, setup, attr, config) {
  return async opts => {
    need(API?.attributeValue, 'attributeValue in the extension API')
    mount.innerHTML = setup()
    const leaf = byId('leaf')
    const saved = {}
    for (const key in config) { saved[key] = Y.config[key]; Y.config[key] = config[key] }
    try {
      const samples = sampleSync(() => API.attributeValue(leaf, attr), plan(opts, 24, 2000), 'us')
      return one(id, 'us', samples)
    } finally {
      Object.assign(Y.config, saved)
      reset()
    }
  }
}

// ---- request context and events ----

function ctxScenario (id, setup) {
  return async opts => {
    need(API?.createRequestContext, 'createRequestContext in the extension API')
    mount.innerHTML = '<div id="t"></div>' + setup() // the ypy-target of the fixtures exists
    const leaf = byId('leaf')
    const samples = sampleSync(() => API.createRequestContext(leaf, {}), plan(opts, 24, 500), 'us')
    reset()
    return one(id, 'us', samples)
  }
}

function triggerScenario (id, name, listeners) {
  return async opts => {
    mount.innerHTML = '<div id="leaf"></div>'
    const leaf = byId('leaf')
    const handlers = []
    for (let k = 0; k < listeners; k++) {
      const handler = () => {}
      document.addEventListener(name, handler)
      handlers.push(handler)
    }
    try {
      const samples = sampleSync(() => Y.trigger(leaf, name, { a: 1 }), plan(opts, 24, 2000), 'us')
      return one(id, 'us', samples)
    } finally {
      for (const handler of handlers) document.removeEventListener(name, handler)
      reset()
    }
  }
}

/** A DOM event handled by an ypy-on attribute or a trigger filter: author JavaScript per event. */
function authorJsScenario (id, markup) {
  return async opts => {
    need(typeof Y.process === 'function', 'ypy.process')
    mount.innerHTML = markup
    Y.process(mount)
    const leaf = byId('leaf')
    const samples = sampleSync(() => leaf.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })), plan(opts, 24, 200), 'us')
    reset()
    return one(id, 'us', samples)
  }
}

/** A click on an element with ypy-get, from the DOM event to ypy:finally:request. */
function clickRequestScenario (id, markup) {
  return async opts => {
    need(typeof Y.process === 'function', 'ypy.process')
    mount.innerHTML = markup
    Y.process(mount)
    setResponse('/o', '')
    const leaf = byId('leaf')
    let done
    const onFinally = () => done()
    document.addEventListener('ypy:finally:request', onFinally)
    try {
      const samples = await sampleAsync(() => new Promise(resolve => {
        done = resolve
        leaf.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }), plan(opts, 24, 50), 'us')
      return one(id, 'us', samples)
    } finally {
      document.removeEventListener('ypy:finally:request', onFinally)
      reset()
    }
  }
}

const REQUEST_EVENTS = [
  'ypy:before:request', 'ypy:before:response', 'ypy:after:request', 'ypy:before:swap', 'ypy:after:swap',
  'ypy:before:settle', 'ypy:after:settle', 'ypy:finally:request'
]

function requestOverheadScenario (id, listeners) {
  return async opts => {
    mount.innerHTML = '<div id="host"></div>'
    setResponse('/o', '')
    const handlers = []
    for (let k = 0; k < listeners; k++) {
      for (const name of REQUEST_EVENTS) {
        const handler = () => {}
        document.addEventListener(name, handler)
        handlers.push([name, handler])
      }
    }
    try {
      const target = byId('host')
      const samples = await sampleAsync(() => go('/o', { target, swap: 'none' }), plan(opts, 24, 50), 'us')
      return one(id, 'us', samples)
    } finally {
      for (const [name, handler] of handlers) document.removeEventListener(name, handler)
      reset()
    }
  }
}

/** Counts the CustomEvents one request dispatches (not timed). */
async function requestEventsScenario () {
  mount.innerHTML = `<div id="host"><ul id="list">${fx.innerList(5, 'wired', 0)}</ul></div>`
  const count = async text => {
    setResponse('/e', text)
    const names = []
    const original = EventTarget.prototype.dispatchEvent
    EventTarget.prototype.dispatchEvent = function (event) {
      if (event instanceof CustomEvent) names.push(event.type)
      return original.call(this, event)
    }
    try {
      await go('/e', { target: byId('list'), swap: 'innerHTML' })
    } finally {
      EventTarget.prototype.dispatchEvent = original
    }
    // a name dispatched under two prefixes is the same event twice: compare what follows the first ':'
    return { dispatched: names.length, distinct: new Set(names.map(n => n.slice(n.indexOf(':') + 1))).size }
  }
  const empty = await count('')
  const rows = await count(fx.innerList(5, 'wired', 1))
  reset()
  return {
    metrics: {
      'request.events.empty.dispatched': { unit: 'count', samples: [empty.dispatched] },
      'request.events.empty.distinct': { unit: 'count', samples: [empty.distinct] },
      'request.events.rows5.dispatched': { unit: 'count', samples: [rows.dispatched] },
      'request.events.rows5.distinct': { unit: 'count', samples: [rows.distinct] }
    },
    note: `empty response: ${empty.dispatched} events dispatched for ${empty.distinct} distinct names; 5 wired rows: ${rows.dispatched} for ${rows.distinct}`
  }
}

// ---- the 500-request session ----

const SESSION = 500
const CHECKPOINT_EVERY = 100

async function sessionScenario (opts) {
  need(window.__benchMem, 'memory binding')
  const total = opts.sessionRequests ?? SESSION
  const memory = []

  // one request: the response is served from the table and dropped right after, so the
  // harness itself keeps nothing alive
  const request = async i => {
    const req = fx.sessionRequest(i)
    setResponse(req.path, req.text, req.status)
    const target = byId(req.options.target.slice(1))
    const t0 = performance.now()
    await go(req.path, { ...req.options, target })
    const dt = performance.now() - t0
    responses.delete(req.path)
    return dt
  }

  // put the page back to its first state through YPY itself, so its own cleanup is what is
  // measured; the content is not byte-identical to the first state, but it has the same size
  const restore = async () => {
    const steps = [
      ['/r/list', fx.innerList(fx.SESSION_LIST_ROWS, 'wired', 0), { target: byId('list'), swap: 'innerHTML' }],
      ['/r/table', fx.morphRows(fx.SESSION_TABLE_ROWS, 0), { target: byId('table'), swap: 'innerMorph' }],
      ['/r/log', '', { target: byId('log'), swap: 'innerHTML' }],
      ['/r/panel', '', { target: byId('panel-host'), swap: 'innerHTML' }]
    ]
    for (const [path, text, options] of steps) {
      setResponse(path, text)
      await go(path, options)
      responses.delete(path)
    }
    await tick(50)
  }

  mount.innerHTML = fx.sessionApp()
  Y.process(mount)
  await tick(50)
  // a warm cycle first, so one-time costs (lazy structures, first-use allocations) are not
  // counted as growth
  for (let i = 0; i < 20; i++) await request(i)
  await restore()
  const before = await window.__benchMem(!!opts.uam)

  const perRequest = []
  let elapsed = 0
  for (let i = 0; i < total; i++) {
    const dt = await request(i)
    perRequest.push(dt * 1000)
    elapsed += dt
    if ((i + 1) % CHECKPOINT_EVERY === 0 && i + 1 < total) memory.push({ at: i + 1, ...(await window.__benchMem()) })
  }
  const peak = await window.__benchMem()
  await restore()
  const after = await window.__benchMem(!!opts.uam)
  memory.push({ at: 'end', ...after })

  const kb = bytes => bytes / 1024
  return {
    metrics: {
      'session.total': { unit: 'ms', samples: [elapsed] },
      'session.request': { unit: 'us', samples: perRequest },
      'session.heap_peak': { unit: 'KB', samples: [kb(peak.heapUsed - before.heapUsed)] },
      'session.heap_retained': { unit: 'KB', samples: [kb(after.heapUsed - before.heapUsed)] },
      'session.nodes_retained': { unit: 'count', samples: [after.nodes - before.nodes] },
      'session.listeners_retained': { unit: 'count', samples: [after.listeners - before.listeners] },
      ...(before.uam != null && after.uam != null
        ? { 'session.uam_retained': { unit: 'KB', samples: [kb(after.uam - before.uam)] } }
        : {})
    },
    note: `${total} requests, heap ${Math.round(kb(before.heapUsed))} KB -> peak +${Math.round(kb(peak.heapUsed - before.heapUsed))} KB -> end ${Math.round(kb(after.heapUsed))} KB, nodes ${before.nodes} -> ${after.nodes}, listeners ${before.listeners} -> ${after.listeners}`,
    memory
  }
}

// ---- the table of scenarios ----

const SCENARIOS = {}
const add = (name, group, run) => { SCENARIOS[name] = { name, group, run } }

for (const n of [10, 100, 1000]) {
  add(`swap.innerHTML.${n}`, 'swap', swapScenario('innerHTML', n, 'wired'))
  add(`swap.outerHTML.${n}`, 'swap', swapScenario('outerHTML', n, 'wired'))
}
for (const n of [100, 1000]) {
  add(`swap.plain.innerHTML.${n}`, 'swap', swapScenario('innerHTML', n, 'plain'))
  add(`swap.ids.innerHTML.${n}`, 'swap', swapScenario('innerHTML', n, 'ids'))
}

for (const n of [10, 100, 1000]) {
  add(`morph.inner.${n}`, 'morph', morphScenario('innerMorph', n))
  add(`morph.outer.${n}`, 'morph', morphScenario('outerMorph', n))
}
for (const n of [100, 1000]) add(`morph.inner.noop.${n}`, 'morph', morphScenario('innerMorph', n, true))

add('process.rich', 'process', processScenario('process.rich', () => fx.richTree(1000), 14))
add('process.plain', 'process', processScenario('process.plain', () => fx.plainTree(5000), 14))

add('attr.local', 'attributes', attrOneScenario('attr.local', () => fx.chain(20, 'ypy-target="#t"', true).replace('<button', '<button ypy-target="#t"'), 'ypy-target'))
for (const depth of [20, 100]) {
  add(`attr.inherit.hit.${depth}`, 'attributes', attrOneScenario(`attr.inherit.hit.${depth}`, () => fx.chain(depth, 'ypy-target:inherited="#t"'), 'ypy-target'))
  add(`attr.inherit.miss.${depth}`, 'attributes', attrOneScenario(`attr.inherit.miss.${depth}`, () => fx.chain(depth, 'class="x"'), 'ypy-target'))
}
add('attr.inherit.append.20', 'attributes', attrOneScenario('attr.inherit.append.20', () => fx.chain(20, 'ypy-vals:append="k:1"', true), 'ypy-vals'))
add('attr.inherit.implicit.100', 'attributes', attrOneScenario('attr.inherit.implicit.100', () => fx.chain(100, 'ypy-target="#t"'), 'ypy-target', { implicitInheritance: true }))
add('attr.mixed.20', 'attributes', attrScenario('attr.mixed.20', () => fx.chain(20, 'ypy-target:inherited="#t" ypy-swap:inherited="outerHTML"')))

add('ctx.create.flat', 'request', ctxScenario('ctx.create.flat', () => '<button id="leaf" ypy-get="/x" ypy-target="#t">Go</button>'))
add('ctx.create.deep20', 'request', ctxScenario('ctx.create.deep20', () => fx.chain(20, 'ypy-target:inherited="#t" ypy-swap:inherited="outerHTML"').replace('<button', '<button ypy-get="/x"')))
add('events.trigger.plain', 'events', triggerScenario('events.trigger.plain', 'bench:event', 0))
add('events.trigger.native', 'events', triggerScenario('events.trigger.native', 'ypy:bench:event', 0))
add('events.trigger.native.listeners5', 'events', triggerScenario('events.trigger.native.listeners5', 'ypy:bench:event', 5))
add('events.on.click', 'events', authorJsScenario('events.on.click', '<button id="leaf" type="button" ypy-on:click="void 0">Go</button>'))
add('events.filter.click', 'events', authorJsScenario('events.filter.click', '<button id="leaf" type="button" ypy-get="/o" ypy-trigger="click[false]">Go</button>'))
add('request.click', 'request', clickRequestScenario('request.click', '<div id="host"><button id="leaf" type="button" ypy-get="/o" ypy-target="#host" ypy-swap="none">Go</button></div>'))
add('request.click.deep20', 'request', clickRequestScenario('request.click.deep20', fx.chain(20, 'ypy-target:inherited="#leaf" ypy-swap:inherited="none"').replace('<button', '<button ypy-get="/o"')))
add('request.overhead', 'request', requestOverheadScenario('request.overhead', 0))
add('request.overhead.listeners', 'request', requestOverheadScenario('request.overhead.listeners', 1))
add('request.events', 'request', requestEventsScenario)

add('session.500', 'session', sessionScenario)

window.__bench = {
  ready: true,
  list: () => Object.values(SCENARIOS).map(({ name, group }) => ({ name, group })),
  async run (name, opts = {}) {
    const scenario = SCENARIOS[name]
    if (!scenario) return { error: `unknown scenario ${name}` }
    reset()
    try {
      await tick(30) // let the start-up processing of the page finish
      return await scenario.run(opts)
    } catch (error) {
      if (error instanceof Skip) return { skipped: error.message }
      return { error: String(error?.stack ?? error) }
    }
  },
  /** For the profiler: runs a scenario again and again for at least `ms` milliseconds. */
  async loop (name, ms, opts = {}) {
    const end = performance.now() + ms
    let runs = 0
    while (performance.now() < end) {
      const result = await this.run(name, opts)
      if (result.error || result.skipped) return result
      runs++
    }
    return { runs }
  }
}
