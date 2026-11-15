// SPDX-License-Identifier: MIT
//
// HTML fixtures for the benchmark scenarios. Plain functions returning strings, loaded by the
// benchmark page next to the scenarios. Everything is deterministic: no random numbers, no dates.

/** A list row with two wired elements (a link and a delete button), no id. */
export const wiredRow = (i, v = 0, withId = false) =>
  `<li class="row"${withId ? ` id="row-${v}-${i}"` : ''} data-id="${i}">` +
  `<a class="name" href="/items/${i}" ypy-get="/items/${i}" ypy-target="#detail" ypy-swap="innerHTML">Item ${i} v${v}</a>` +
  `<span class="meta">Updated ${(i + v) % 60}m ago</span>` +
  `<button type="button" class="btn" ypy-delete="/items/${i}" ypy-target="closest li" ypy-swap="outerHTML" ypy-confirm="Delete item ${i}?">Delete</button>` +
  `</li>`

/** The same row without any YPY attribute. */
export const plainRow = (i, v = 0) =>
  `<li class="row" data-id="${i}">` +
  `<a class="name" href="/items/${i}">Item ${i} v${v}</a>` +
  `<span class="meta">Updated ${(i + v) % 60}m ago</span>` +
  `<button type="button" class="btn">Delete</button>` +
  `</li>`

export const rows = (n, make, v = 0) => Array.from({ length: n }, (_, i) => make(i, v)).join('')

/**
 * The rows for an `innerHTML` swap, and the whole list for an `outerHTML` swap. `kind` is
 * "wired" (default), "plain" (no YPY attribute) or "ids" (wired, with an id that differs from
 * one variant to the next, so the swap looks for matching ids and finds none).
 */
export const innerList = (n, kind, v) =>
  rows(n, kind === 'plain' ? plainRow : kind === 'ids' ? (i, w) => wiredRow(i, w, true) : wiredRow, v)
export const outerList = (n, kind, v) => `<ul id="list">${innerList(n, kind, v)}</ul>`

/**
 * Rows for the morph scenarios: every row and its input carry an id, so a morph can keep the
 * focus and the typed value. Variant 1 edits every 10th label, marks every 7th row, swaps rows
 * 6 and 7, drops the last row and appends a new one. Row 2 is never touched: it is the one the
 * scenarios focus and type into.
 */
export function morphRows (n, variant = 0) {
  const list = Array.from({ length: n }, (_, i) => ({ id: i, label: `Label ${i}`, cls: 'row' }))
  if (variant === 1) {
    for (let i = 0; i < n; i += 10) list[i].label += ' (edited)'
    for (let i = 0; i < n; i += 7) list[i].cls = 'row hot'
    if (n > 8) [list[6], list[7]] = [list[7], list[6]]
    list.pop()
    list.push({ id: n, label: `Label ${n}`, cls: 'row new' })
  }
  return list.map(r =>
    `<li id="r-${r.id}" class="${r.cls}">` +
    `<input id="in-${r.id}" name="f-${r.id}" type="text" value="v-${r.id}">` +
    `<span class="label">${r.label}</span>` +
    `<button type="button" class="btn" ypy-delete="/items/${r.id}" ypy-target="closest li" ypy-swap="outerHTML">Go</button>` +
    `</li>`).join('')
}

export const morphOuter = (n, variant) => `<ul id="list">${morphRows(n, variant)}</ul>`

/**
 * A large tree for process(): `n` rows with a mix of attributes under both prefixes, wired
 * and plain elements, and ypy-on handlers. About 7 elements per row, 4 of them wired.
 */
export function richTree (n) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(
      `<div class="row" ypy-get="/rows/${i}" ypy-trigger="click" ypy-target="#out" data-ypy-swap="innerHTML">` +
      `<button type="button" ypy-post="/a/${i}" ypy-target="#t" ypy-swap="outerHTML" ypy-confirm="Sure?">Act</button>` +
      `<input name="q${i}" ypy-get="/s" ypy-trigger="input changed delay:300ms" ypy-target="next .out" ypy-indicator="#sp">` +
      `<span class="out"></span>` +
      `<span ypy-on:click="void 0" ypy-on::before:request="void 0">Hint</span>` +
      `<a href="/p/${i}" ypy-boost="true">Page</a>` +
      `<p class="note">Plain paragraph ${i}</p>` +
      `</div>`)
  }
  return `<section ypy-boost="true" ypy-target:inherited="#out">${out.join('')}</section>`
}

/** `n` elements with a class and no YPY attribute, in rows of 5 (about 6 nodes per 5 elements). */
export function plainTree (n) {
  const out = []
  for (let i = 0; i < n; i += 5) {
    out.push(`<div class="row"><span>${i}</span><a href="/p/${i}">link</a><p class="note">text ${i}</p><em>x</em></div>`)
  }
  return `<section>${out.join('')}</section>`
}

/**
 * A chain of `depth` nested elements ending in a button. `attrs` are put on the outermost
 * element (and on every level when `every` is true).
 */
export function chain (depth, attrs = '', every = false) {
  let open = '', close = ''
  for (let level = 0; level < depth; level++) {
    open += `<div class="lvl"${every || level === 0 ? ' ' + attrs : ''}>`
    close += '</div>'
  }
  return `${open}<button type="button" id="leaf">Leaf</button>${close}`
}

// ---- the 500-request session ----

export const SESSION_LIST_ROWS = 50
export const SESSION_TABLE_ROWS = 40

export const sessionApp = () =>
  `<main id="app">` +
  `<section><ul id="list">${innerList(SESSION_LIST_ROWS, 'wired', 0)}</ul></section>` +
  `<section><ul id="table">${morphRows(SESSION_TABLE_ROWS, 0)}</ul></section>` +
  `<section id="card-host">${card(0)}</section>` +
  `<aside id="notices"><p>No notices</p></aside>` +
  `<ul id="log"></ul>` +
  `<div id="panel-host"></div>` +
  `</main>`

const card = i =>
  `<article id="card" class="card"><h2>Card ${i}</h2>` +
  `<form ypy-post="/card" ypy-target="#card" ypy-swap="outerMorph"><input id="card-name" name="name" value="name ${i}">` +
  `<button type="submit" class="btn">Save</button></form></article>`

/**
 * Request number `i` of the session. The ten kinds repeat in order, so the mix is fixed:
 * 3 innerHTML list swaps, 1 outerHTML list swap, 2 table morphs, 1 card morph with an
 * out-of-band notice, 1 append, 1 empty 204, 1 select from a full page.
 * @returns {{path: string, status: number, text: string, options: object}}
 */
export function sessionRequest (i) {
  const path = `/s/${i}`
  switch (i % 10) {
    case 0: case 1: case 2:
      return { path, status: 200, text: innerList(SESSION_LIST_ROWS, 'wired', i), options: { target: '#list', swap: 'innerHTML' } }
    case 3:
      return { path, status: 200, text: outerList(SESSION_LIST_ROWS, 'wired', i), options: { target: '#list', swap: 'outerHTML' } }
    case 4: case 5:
      return { path, status: 200, text: morphRows(SESSION_TABLE_ROWS, (i >> 1) % 2), options: { target: '#table', swap: 'innerMorph' } }
    case 6:
      return {
        path, status: 200,
        text: card(i) + `<div id="notices" ypy-swap-oob="true"><p>Saved ${i}</p></div>`,
        options: { target: '#card', swap: 'outerMorph' }
      }
    case 7:
      return {
        path, status: 200,
        text: `<li class="entry" ypy-delete="/log/${i}" ypy-target="this" ypy-swap="delete">Entry ${i}</li>`,
        options: { target: '#log', swap: 'beforeend' }
      }
    case 8:
      return { path, status: 204, text: '', options: { target: '#list', swap: 'innerHTML' } }
    default:
      return {
        path, status: 200,
        text: `<!doctype html><html><head><title>Page ${i}</title></head><body><header>Header</header>` +
          `<div class="panel"><h3>Panel ${i}</h3>${innerList(8, 'wired', i)}</div><footer>Footer</footer></body></html>`,
        options: { target: '#panel-host', swap: 'innerHTML', select: '.panel' }
      }
  }
}
