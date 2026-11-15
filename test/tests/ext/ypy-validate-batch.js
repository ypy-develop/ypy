// SPDX-License-Identifier: MIT
// ypy-validate: several fields asked within a short window go in one request.
describe('ypy-validate extension: batches', function () {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-validate.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    beforeEach(() => {
        setupTest(this.currentTest);
    });

    afterEach(async () => {
        delete ypy.config.validate;
        cleanupTest();
        await wait(10);
    });

    const wait = ms => ypy.timeout(ms);
    const posts = () => fetchMock.getCalls().filter(c => c.request.method === 'POST');
    const bad = (html, status = 422) => mockResponse('POST', '/v', html, {status});
    const oob = (id, text) => `<small id="${id}" ypy-swap-oob="innerHTML">${text}</small>`;

    function form(attrs = 'ypy-validate-batch="30ms"', extra = '') {
        createProcessedHTML(
            `<form id="f" ypy-validate-fields="/v" ypy-validate-trigger="change delay:5ms" ${attrs}>` +
            '<input id="a" name="a" value="1"><small id="a-error"></small>' +
            '<input id="b" name="b" value="2"><small id="b-error"></small>' +
            `<input id="c" name="c" value="3"><small id="c-error"></small>${extra}</form>`);
    }

    const change = id => find('#' + id).dispatchEvent(new Event('change', {bubbles: true}));

    it('sends the fields asked within the window in one request, with the names in YPY-Validate', async function () {
        form();
        bad('', 204);
        change('a');
        change('b');
        await wait(120);
        assert.equal(posts().length, 1);
        let call = lastFetch();
        assert.equal(call.request.headers['YPY-Validate'], 'a,b');
        assert.equal(call.request.body.get('a'), '1');
        assert.equal(call.request.body.get('c'), '3', 'every value of the form goes, as for one field');
    });

    it('keeps the order of the first ask, and a field twice counts once', async function () {
        form();
        bad('', 204);
        change('c');
        await wait(15);
        change('a');
        change('c');
        await wait(120);
        assert.equal(posts().length, 1);
        assert.equal(lastFetch().request.headers['YPY-Validate'], 'c,a');
    });

    it('shows each invalid field its message from the out-of-band elements, and marks only those', async function () {
        form();
        find('#b-error').textContent = 'old message';
        find('#b').setAttribute('aria-invalid', 'true');
        bad(oob('a-error', 'Taken'));
        change('a');
        change('b');
        await wait(120);
        assert.equal(find('#a-error').textContent, 'Taken');
        assert.equal(find('#a').getAttribute('aria-invalid'), 'true');
        assert.include(find('#a').getAttribute('aria-describedby').split(' '), 'a-error');
        assert.equal(find('#b-error').textContent, '', 'a field the answer does not name is valid');
        assert.isFalse(find('#b').hasAttribute('aria-invalid'));
        assert.isFalse(find('#c').hasAttribute('aria-invalid'), 'a field that was not asked is left alone');
    });

    it('shows two invalid fields from one answer', async function () {
        form();
        bad(oob('a-error', 'Taken') + oob('b-error', 'Too short'));
        change('a');
        change('b');
        await wait(120);
        assert.equal(posts().length, 1);
        assert.equal(find('#a-error').textContent, 'Taken');
        assert.equal(find('#b-error').textContent, 'Too short');
        assert.equal(find('#b').getAttribute('aria-invalid'), 'true');
    });

    it('clears every place and aria-invalid when the answer is 2xx', async function () {
        form();
        for (let id of ['a', 'b']) {
            find('#' + id + '-error').textContent = 'old';
            find('#' + id).setAttribute('aria-invalid', 'true');
        }
        bad('', 204);
        change('a');
        change('b');
        await wait(120);
        for (let id of ['a', 'b']) {
            assert.equal(find('#' + id + '-error').textContent, '');
            assert.isFalse(find('#' + id).hasAttribute('aria-invalid'));
        }
    });

    it('leaves everything as it was for a server error', async function () {
        form();
        find('#a-error').textContent = 'old';
        find('#a').setAttribute('aria-invalid', 'true');
        bad('boom', 500);
        change('a');
        change('b');
        await wait(120);
        assert.equal(find('#a-error').textContent, 'old');
        assert.equal(find('#a').getAttribute('aria-invalid'), 'true');
    });

    it('sends a single field as before: one name, the usual answer in its place', async function () {
        form();
        bad('<u>Taken</u>');
        change('a');
        await wait(120);
        assert.equal(posts().length, 1);
        assert.equal(lastFetch().request.headers['YPY-Validate'], 'a');
        assert.equal(find('#a-error').innerHTML, '<u>Taken</u>');
        assert.equal(find('#a').getAttribute('aria-invalid'), 'true');
    });

    it('makes a second request for a field that asks after the window ended', async function () {
        form();
        bad('', 204);
        change('a');
        await wait(100);
        change('b');
        await wait(100);
        assert.equal(posts().length, 2);
        assert.deepEqual(posts().map(p => p.request.headers['YPY-Validate']), ['a', 'b']);
    });

    it('does not batch without ypy-validate-batch: one request per field', async function () {
        form('');
        bad('', 204);
        change('a');
        change('b');
        await wait(100);
        assert.equal(posts().length, 2);
    });

    it('is turned on by ypy.config.validate.batch, and a field turns it off with ypy-validate-batch="false"', async function () {
        ypy.config.validate = {batch: '30ms'};
        form('');
        find('#c').setAttribute('ypy-validate-batch', 'false');
        ypy.process(find('#f'));
        bad('', 204);
        change('a');
        change('b');
        change('c');
        await wait(120);
        assert.deepEqual(posts().map(p => p.request.headers['YPY-Validate']).sort(), ['a,b', 'c']);
    });

    it('takes a bare ypy-validate-batch as 50ms', async function () {
        form('ypy-validate-batch');
        bad('', 204);
        change('a');
        await wait(30);
        change('b');
        await wait(150);
        assert.equal(posts().length, 1);
        assert.equal(lastFetch().request.headers['YPY-Validate'], 'a,b');
    });

    it('does not mix fields of two forms or of two URLs', async function () {
        createProcessedHTML(
            '<div><form ypy-validate-fields="/v" ypy-validate-trigger="change delay:5ms" ypy-validate-batch="30ms"><input id="a" name="a"></form>' +
            '<form ypy-validate-fields="/v" ypy-validate-trigger="change delay:5ms" ypy-validate-batch="30ms"><input id="b" name="b"></form>' +
            '<form ypy-validate-batch="30ms"><input id="c" name="c" ypy-validate="/other" ypy-validate-trigger="change delay:5ms"><input id="d" name="d" ypy-validate="/v" ypy-validate-trigger="change delay:5ms"></form></div>');
        bad('', 204);
        mockResponse('POST', '/other', '', {status: 204});
        for (let id of ['a', 'b', 'c', 'd']) change(id);
        await wait(120);
        assert.deepEqual(posts().map(p => p.request.headers['YPY-Validate']).sort(), ['a', 'b', 'c', 'd']);
    });

    it('starts the whole batch again when a field of a batch in flight asks again', async function () {
        form();
        let held = mockSequentialResponses('POST', '/v', new MockResponse('', {status: 204}));
        change('a');
        change('b');
        await wait(80);
        assert.equal(held.pendingCount, 1);
        assert.equal(lastFetch().request.headers['YPY-Validate'], 'a,b');
        change('a');
        await wait(80);
        let sent = posts();
        assert.equal(sent.length, 2);
        assert.equal(sent[0].request.signal.aborted, true, 'the first request was cancelled');
        assert.equal(sent[1].request.headers['YPY-Validate'], 'a,b', 'b is asked again with a');
        await held.next();
        await held.next();
    });

    it('does not ask for a field that left the page during the window', async function () {
        form();
        bad('', 204);
        change('a');
        change('b');
        find('#b').remove();
        await wait(120);
        assert.equal(posts().length, 1);
        assert.equal(lastFetch().request.headers['YPY-Validate'], 'a');
    });
});
