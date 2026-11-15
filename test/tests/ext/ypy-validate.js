// SPDX-License-Identifier: MIT
describe('ypy-validate extension', function () {

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
        cleanupTest();
        await wait(10);
    });

    const wait = ms => ypy.timeout(ms);
    const posts = url => fetchMock.getCalls().filter(c => c.request.method === 'POST' && (!url || c.url === url));
    const invalid = (status = 422, body = '<span>Taken</span>') => mockResponse('POST', '/signup/validate', body, {status});

    // A sign-up form whose email field is checked by the server; the delay is short to keep the suite fast
    function signup(emailAttrs = 'ypy-validate="/signup/validate" ypy-validate-trigger="change delay:5ms"') {
        createProcessedHTML(
            '<div><form id="f" ypy-post="/signup" ypy-target="#result">' +
            `<input id="email" name="email" value="ana@example.com" ${emailAttrs}><small id="email-error"></small>` +
            '<input id="name" name="name" value="Ana"><button>Create</button></form><div id="result"></div></div>');
    }

    async function leave(selector = '#email', type = 'change') {
        find(selector).dispatchEvent(new Event(type, {bubbles: true}));
        await wait(40);
    }

    // -------------------------------------------------------------------------
    // The request
    // -------------------------------------------------------------------------

    it('asks the validation URL with every value of the form and the name of the field', async function () {
        signup();
        invalid(204, '');
        await leave();
        assert.equal(posts().length, 1);
        let call = lastFetch();
        assert.equal(call.url, '/signup/validate');
        assert.equal(call.request.headers['YPY-Validate'], 'email');
        assert.equal(call.request.body.get('email'), 'ana@example.com');
        assert.equal(call.request.body.get('name'), 'Ana', 'rules that compare fields can see them');
        assert.equal(posts('/signup').length, 0, 'the form was not submitted');
    });

    it('waits for the default delay and sends once, whatever the number of events', async function () {
        signup('ypy-validate="/signup/validate"');
        invalid(204, '');
        for (let i = 0; i < 3; i++) find('#email').dispatchEvent(new Event('change', {bubbles: true}));
        await wait(80);
        assert.equal(posts().length, 0, 'still within the debounce');
        await wait(250);
        assert.equal(posts().length, 1);
    });

    it('debounces a trigger of the author: input events collapse into one request', async function () {
        signup('ypy-validate="/signup/validate" ypy-validate-trigger="input delay:30ms"');
        invalid(204, '');
        for (let i = 0; i < 5; i++) find('#email').dispatchEvent(new Event('input', {bubbles: true}));
        await wait(100);
        assert.equal(posts().length, 1);
        find('#email').dispatchEvent(new Event('change', {bubbles: true}));
        await wait(60);
        assert.equal(posts().length, 1, 'change is not the trigger any more');
    });

    it('uses the action of the form for a bare attribute', async function () {
        createProcessedHTML('<form ypy-post="/signup/validate"><input id="email" name="email" ypy-validate ypy-validate-trigger="change delay:5ms"></form>');
        invalid(204, '');
        await leave();
        assert.equal(lastFetch().url, '/signup/validate');
    });

    it('uses the action attribute of a plain form for a bare attribute', async function () {
        createProcessedHTML('<form action="/signup/validate" method="post"><input id="email" name="email" ypy-validate ypy-validate-trigger="change delay:5ms"></form>');
        invalid(204, '');
        await leave();
        assert.equal(lastFetch().url, '/signup/validate');
    });

    it('validates a field that has no form around it', async function () {
        createProcessedHTML('<div><input id="email" name="email" value="x" ypy-validate="/signup/validate" ypy-validate-trigger="change delay:5ms"></div>');
        invalid(204, '');
        await leave();
        assert.equal(lastFetch().request.body.get('email'), 'x');
    });

    it('leaves ypy-validate="true" and "false" to the core: nothing is sent', async function () {
        createProcessedHTML('<form><input id="a" name="a" ypy-validate="true"><input id="b" name="b" ypy-validate="false"></form>');
        await leave('#a');
        await leave('#b');
        assert.equal(fetchMock.getCalls().length, 0);
    });

    it('wires every field of ypy-validate-fields, except those that opt out or name another URL', async function () {
        mockResponse('POST', '/other', '', {status: 204});
        invalid(204, '');
        createProcessedHTML(
            '<form ypy-post="/signup" ypy-validate-fields="/signup/validate" ypy-validate-trigger="change delay:5ms">' +
            '<input id="a" name="a"><input id="b" name="b" ypy-validate="false"><input id="c" name="c" ypy-validate="/other">' +
            '<select id="d" name="d"><option>1</option></select><textarea id="e" name="e"></textarea></form>');
        for (let id of ['a', 'b', 'c', 'd', 'e']) await leave('#' + id);
        assert.deepEqual(posts().map(c => c.url + ' ' + c.request.headers['YPY-Validate']),
            ['/signup/validate a', '/other c', '/signup/validate d', '/signup/validate e']);
    });

    it('uses the action of the form for a bare ypy-validate-fields', async function () {
        mockResponse('POST', '/signup', '', {status: 204});
        createProcessedHTML('<form ypy-post="/signup" ypy-validate-fields><input id="a" name="a" ypy-validate-trigger="change delay:5ms"></form>');
        await leave('#a');
        assert.equal(lastFetch().url, '/signup');
        assert.equal(lastFetch().request.headers['YPY-Validate'], 'a');
    });

    it('wires fields that arrive in a later swap', async function () {
        invalid(204, '');
        createProcessedHTML('<form id="f" ypy-validate-fields="/signup/validate"></form>');
        find('#f').innerHTML = '<input id="late" name="late" ypy-validate-trigger="change delay:5ms">';
        ypy.process(find('#f'));
        await leave('#late');
        assert.equal(lastFetch().request.headers['YPY-Validate'], 'late');
    });

    it('wires a field once however many times it is processed', async function () {
        signup();
        invalid(204, '');
        ypy.process(playground());
        ypy.process(playground());
        await leave();
        assert.equal(posts().length, 1);
    });

    it('uses ypy-validate-trigger: blur only', async function () {
        signup('ypy-validate="/signup/validate" ypy-validate-trigger="blur delay:5ms"');
        invalid(204, '');
        await leave('#email', 'change');
        assert.equal(posts().length, 0);
        await leave('#email', 'blur');
        assert.equal(posts().length, 1);
    });

    it('sends the values as text for a multipart form when the field asks for it with ypy-encoding', async function () {
        createProcessedHTML('<form enctype="multipart/form-data">' +
            '<input id="a" name="a" ypy-validate="/signup/validate" ypy-validate-trigger="change delay:5ms">' +
            '<input id="b" name="b" ypy-validate="/signup/validate" ypy-validate-trigger="change delay:5ms" ypy-encoding="application/x-www-form-urlencoded"></form>');
        invalid(204, '');
        await leave('#a');
        assert.instanceOf(lastFetch().request.body, FormData);
        await leave('#b');
        assert.instanceOf(lastFetch().request.body, URLSearchParams);
    });

    // -------------------------------------------------------------------------
    // The answer
    // -------------------------------------------------------------------------

    it('shows a 422 in the place the page made, and marks the field', async function () {
        signup();
        invalid();
        await leave();
        assert.equal(find('#email-error').innerHTML, '<span>Taken</span>');
        assert.equal(find('#email').getAttribute('aria-invalid'), 'true');
        assert.include(find('#email').getAttribute('aria-describedby').split(' '), 'email-error');
        assert.equal(find('#result').textContent, '', 'nothing went to the target of the form');
    });

    it('keeps the aria-describedby that was there, and adds the place once', async function () {
        signup('ypy-validate="/signup/validate" ypy-validate-trigger="change delay:5ms" aria-describedby="hint"');
        invalid();
        await leave();
        await leave();
        assert.equal(find('#email').getAttribute('aria-describedby'), 'hint email-error');
    });

    it('does not take the focus away from where the user is', async function () {
        signup();
        invalid();
        find('#name').focus();
        await leave();
        assert.equal(document.activeElement, find('#name'));
    });

    it('clears the message and aria-invalid when the field becomes valid (204)', async function () {
        signup();
        invalid();
        await leave();
        assert.equal(find('#email').getAttribute('aria-invalid'), 'true');
        invalid(204, '');
        await leave();
        assert.equal(find('#email-error').innerHTML, '');
        assert.isFalse(find('#email').hasAttribute('aria-invalid'));
    });

    it('clears them for an empty 200 too', async function () {
        signup();
        invalid();
        await leave();
        invalid(200, '  ');
        await leave();
        assert.equal(find('#email-error').innerHTML, '');
        assert.isFalse(find('#email').hasAttribute('aria-invalid'));
    });

    it('shows the body of a 200 as it is, and the field is valid', async function () {
        signup();
        invalid();
        await leave();
        invalid(200, '<em>Available</em>');
        await leave();
        assert.equal(find('#email-error').innerHTML, '<em>Available</em>');
        assert.isFalse(find('#email').hasAttribute('aria-invalid'));
    });

    it('makes the place after the field when the page has none', async function () {
        createProcessedHTML('<form><input id="user" name="user" ypy-validate="/signup/validate" ypy-validate-trigger="change delay:5ms"><button>Go</button></form>');
        invalid();
        await leave('#user');
        let box = find('#user').nextElementSibling;
        assert.equal(box.id, 'user-error');
        assert.equal(box.className, 'ypy-field-error');
        assert.equal(box.getAttribute('aria-live'), 'polite');
        assert.equal(box.innerHTML, '<span>Taken</span>');
        assert.equal(find('#user').getAttribute('aria-describedby'), 'user-error');
        await leave('#user');
        assert.equal(playground().querySelectorAll('.ypy-field-error').length, 1, 'made once');
    });

    it('sends the answer where ypy-error-target says, with the extended selectors', async function () {
        createProcessedHTML(
            '<form><div class="row"><input id="user" name="user" ypy-validate="/signup/validate" ypy-validate-trigger="change delay:5ms" ypy-error-target="next .msg"><span class="msg"></span></div></form>');
        invalid();
        await leave('#user');
        assert.equal(find('.msg').innerHTML, '<span>Taken</span>');
        assert.include(find('#user').getAttribute('aria-describedby'), find('.msg').id);
    });

    it('reads ypy-error-swap from the field', async function () {
        signup('ypy-validate="/signup/validate" ypy-validate-trigger="change delay:5ms" ypy-error-swap="beforeend"');
        find('#email-error').textContent = 'old ';
        invalid();
        await leave();
        assert.equal(find('#email-error').innerHTML, 'old <span>Taken</span>');
    });

    it('moves the focus when ypy-error-focus asks for it', async function () {
        signup('ypy-validate="/signup/validate" ypy-validate-trigger="change delay:5ms" ypy-error-focus="#email"');
        invalid();
        find('#name').focus();
        await leave();
        assert.equal(document.activeElement, find('#email'));
    });

    it('does not replace the form: a 422 for a field is not the form invalid', async function () {
        signup();
        let name = find('#name');
        name.value = 'typed';
        invalid();
        await leave();
        assert.equal(find('#email-error').innerHTML, '<span>Taken</span>');
        assert.equal(find('#name'), name);
        assert.equal(name.value, 'typed');
        assert.equal(find('#email').getAttribute('aria-invalid'), 'true');
    });

    it('ignores a server error: no message, no aria-invalid, the field stays as it was', async function () {
        signup();
        invalid(500, 'Internal error page');
        await leave();
        assert.equal(find('#email-error').innerHTML, '');
        assert.isFalse(find('#email').hasAttribute('aria-invalid'));
        invalid();
        await leave();
        invalid(503, 'down');
        await leave();
        assert.equal(find('#email-error').innerHTML, '<span>Taken</span>', 'an earlier message is not wiped by an error');
        assert.equal(find('#email').getAttribute('aria-invalid'), 'true');
    });

    it('ignores a network failure the same way', async function () {
        signup();
        mockFailure('POST', '/signup/validate');
        let errors = 0;
        let count = () => errors++;
        document.addEventListener('ypy:error', count);
        await leave();
        document.removeEventListener('ypy:error', count);
        assert.equal(find('#email-error').innerHTML, '');
        assert.isFalse(find('#email').hasAttribute('aria-invalid'));
        assert.equal(errors, 1, 'the core still reports it');
    });

    // -------------------------------------------------------------------------
    // Concurrency
    // -------------------------------------------------------------------------

    it('cancels the answer that is still in flight when the field changes again', async function () {
        signup();
        let held = mockSequentialResponses('POST', '/signup/validate', new MockResponse('<span>first</span>', {status: 422}));
        await leave();
        await leave();
        assert.equal(held.pendingCount, 2);
        await held.next();   // the cancelled one
        await held.next();
        await wait(40);
        assert.equal(find('#email-error').innerHTML, '<span>first</span>');
        assert.equal(find('#email').getAttribute('aria-invalid'), 'true');
        assert.equal(find('#email-error').querySelectorAll('span').length, 1);
    });

    it('keeps the newest answer when an old one arrives late', async function () {
        signup();
        let first = mockSequentialResponses('POST', '/signup/validate', new MockResponse('<span>old</span>', {status: 422}));
        await leave();
        // the field changes again, and this time the server is quick
        mockResponse('POST', '/signup/validate', '<span>new</span>', {status: 422});
        await leave();
        await first.next();
        await wait(40);
        assert.equal(find('#email-error').innerHTML, '<span>new</span>');
    });

    it('checks two fields at the same time, each with its own place', async function () {
        createProcessedHTML(
            '<form ypy-validate-fields="/signup/validate" ypy-validate-trigger="change delay:5ms">' +
            '<input id="a" name="a"><i id="a-error"></i><input id="b" name="b"><i id="b-error"></i></form>');
        let held = mockSequentialResponses('POST', '/signup/validate', new MockResponse('<u>bad</u>', {status: 422}));
        await leave('#a');
        await leave('#b');
        assert.equal(held.pendingCount, 2);
        await held.next();
        await held.next();
        await wait(40);
        assert.equal(find('#a-error').innerHTML, '<u>bad</u>');
        assert.equal(find('#b-error').innerHTML, '<u>bad</u>');
        assert.equal(find('#a').getAttribute('aria-invalid'), 'true');
        assert.equal(find('#b').getAttribute('aria-invalid'), 'true');
    });

    it('lets a submit of the form cancel the field checks that are still running', async function () {
        signup();
        mockResponse('POST', '/signup', '<p>done</p>');
        let held = mockSequentialResponses('POST', '/signup/validate', new MockResponse('<span>late</span>', {status: 422}));
        await leave();
        assert.equal(held.pendingCount, 1);
        find('button').click();
        await forRequest();
        await held.next();
        await wait(40);
        assert.equal(find('#result').innerHTML, '<p>done</p>');
        assert.equal(find('#email-error').innerHTML, '', 'the cancelled check showed nothing');
        assert.isFalse(find('#email').hasAttribute('aria-invalid'));
    });

    it('does not send the validation request when the field left the page during the delay', async function () {
        signup('ypy-validate="/signup/validate" ypy-validate-trigger="change delay:30ms"');
        invalid(204, '');
        find('#email').dispatchEvent(new Event('change', {bubbles: true}));
        let email = find('#email');
        email.remove();
        await wait(80);
        assert.equal(posts().length, 0);
    });

    it('sends nothing on its own: the form submit is a different request', async function () {
        signup();
        mockResponse('POST', '/signup', '<p>done</p>');
        find('button').click();
        await forRequest();
        assert.equal(posts().length, 1);
        assert.isUndefined(lastFetch().request.headers['YPY-Validate']);
    });
});
