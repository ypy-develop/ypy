// SPDX-License-Identifier: MIT
//
// A throwaway page for the security tests. YPY reads its `<meta>` tag and the page CSP when it is
// constructed, so a test that needs a particular `<head>` loads a fresh copy of the core into an
// iframe. Warnings and errors the page logs are collected in `logs`.
//
//   let page = await openPage({head: '<meta name="ypy-config" content="locked:true">'})
//   page.win.ypy.config.mode
//   page.close()

export async function openPage({head = '', body = '', scripts = ['/src/ypy.js'], nonce = ''} = {}) {
    let iframe = document.createElement('iframe')
    let nonceAttr = nonce ? ` nonce="${nonce}"` : ''
    let capture = `<script${nonceAttr}>window.__logs = []; for (let level of ['warn', 'error']) console[level] = (...args) => window.__logs.push(level + ': ' + args.map(String).join(' '))</script>`
    let tags = scripts.map(src => `<script${nonceAttr} src="${src}"></script>`).join('')
    iframe.srcdoc = `<!doctype html><html><head>${head}${capture}</head><body>${body}${tags}</body></html>`
    document.body.appendChild(iframe)
    await new Promise(resolve => iframe.addEventListener('load', resolve, {once: true}))
    let win = iframe.contentWindow
    await new Promise(resolve => win.setTimeout(resolve, 30))
    return {
        iframe,
        win,
        doc: iframe.contentDocument,
        logs: win.__logs,
        close: () => iframe.remove()
    }
}
