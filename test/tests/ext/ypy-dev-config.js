// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// TASK-051: what ypy-dev reads from the configuration tag at start (a fresh page for each case).
describe('ypy-dev start-up options', function () {

    let page;
    afterEach(function () { page?.close(); page = null });

    const open = (content, head = '') => openPage({
        head: `<meta name="ypy-config" content='${content}'>${head}`,
        scripts: ['/src/ypy.js', '/src/ext/ypy-dev.js']
    });

    it('dev.latency:300 and dev.offline:true set the simulator at start', async function () {
        page = await open('dev.latency:300,dev.offline:true');
        assert.deepInclude(page.win.ypy.dev.simulation, {min: 300, max: 300, offline: true});
        assert.equal(page.win.navigator.onLine, false);
    });

    it('a range needs the JSON form of the tag', async function () {
        page = await open('{"dev":{"latency":[100,800]}}');
        assert.deepInclude(page.win.ypy.dev.simulation, {min: 100, max: 800, offline: false});
    });

    it('dev.reload:true listens on /__ypy/reload and dev.reload:"/x" on that URL', async function () {
        let fake = '<script>window.__es = []; window.EventSource = class { constructor(u) { this.url = u; window.__es.push(u) } addEventListener() {} close() {} }</script>';
        page = await open('dev.reload:true', fake);
        assert.deepEqual(page.win.__es, ['/__ypy/reload']);
        page.close();
        page = await open('dev.reload:"/x/events"', fake);
        assert.deepEqual(page.win.__es, ['/x/events']);
    });

    it('dev:false starts nothing and says nothing', async function () {
        page = await open('dev:false');
        page.doc.body.innerHTML = '<button ypy-gett="/x">Go</button>';
        page.win.ypy.process(page.doc.body);
        assert.deepEqual(page.win.ypy.dev.messages, []);
        assert.equal(page.logs.length, 0);
    });

    it('says once that it is on, and that a host which is not a development host is suspect', async function () {
        page = await openPage({
            head: '<script>window.__info = []; console.info = (...a) => window.__info.push(a.join(" "))</script>',
            scripts: ['/src/ypy.js', '/src/ext/ypy-dev.js']
        });
        assert.deepEqual(page.win.__info, ['ypy-dev: development helpers are on. Do not ship ypy-dev to production.']);
        // an srcdoc page has no host name, like a file: page: no host warning
        assert.deepEqual(page.logs.filter(l => /does not look like a development host/.test(l)), []);
    });
});
