// SPDX-License-Identifier: MIT
// ypy-nav: a click on a link takes the focus away from the field before the click event (the browser
// blurs at mousedown), and the change of that field has already started its save. The navigation
// still waits for that save: the field typed in last counts, not only the one that has the focus.
describe('ypy-nav extension: the field blurred by the click', function () {

    let extBackup, mount;
    const find2 = selector => document.querySelector(selector);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const urls = () => fetchMock.getCalls().map(c => c.url);
    const click = elt => elt.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
    const guardClick = evt => { if (!evt.defaultPrevented) evt.preventDefault() };
    const type = (elt, value) => { elt.value = value; elt.dispatchEvent(new Event('input', {bubbles: true})) };

    const PAGE = `<form id="f"><input id="i" name="a" ypy-post="/save" ypy-trigger="change" ypy-swap="none"></form>
        <a id="a" href="/page" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a><div id="out"></div>`;

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-nav.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
        window.addEventListener('click', guardClick);
    });

    after(() => {
        window.removeEventListener('click', guardClick);
        restoreExtensions(extBackup);
    });

    beforeEach(() => {
        setupTest(this.currentTest);
        ypy.config.nav = {boost: true};
        mount = document.createElement('div');
        document.body.append(mount);
        mount.innerHTML = PAGE;
        ypy.process(mount);
    });

    afterEach(() => {
        delete ypy.config.nav;
        mount.remove();
        cleanupTest();
    });

    it('waits for the save a change started when the field was already blurred', async function () {
        let hold = mockSequentialResponses('POST', '/save', 'saved');
        mockResponse('GET', '/page', 'Next');
        let i = find2('#i');
        i.focus();
        type(i, 'draft');
        i.dispatchEvent(new Event('change', {bubbles: true}));
        i.blur();   // what mousedown does before the click
        click(find2('#a'));
        await wait(100);
        urls().should.deep.equal(['/save']);
        hold.next();
        await wait(100);
        urls().should.deep.equal(['/save', '/page']);
        find2('#out').textContent.should.equal('Next');
    });

    it('does not wait when nothing was typed', async function () {
        mockResponse('GET', '/page', 'Next');
        click(find2('#a'));
        await wait(100);
        urls().should.deep.equal(['/page']);
    });
});
