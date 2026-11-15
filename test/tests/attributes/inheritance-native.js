// SPDX-License-Identifier: MIT
//
// TASK-018: attribute inheritance is explicit. The matrix below runs every attribute of
// test/lib/inheritance-rules.js directly, over two levels, with :append and with the other
// attribute spellings.
import {RULES} from '../../lib/inheritance-rules.js';

/** The button inside the markup; the markup may use {A} for the attribute name. */
function button(html, attr) {
    return createDisconnectedHTML(html.replaceAll('{A}', attr)).querySelector('button');
}

/** Reads like the core does. */
function read(rule, elt, attr = rule.attr) {
    return ypy.__attributeValue(elt, attr);
}

describe('attribute inheritance matrix', function () {

    afterEach(function () {
        ypy.config.metaCharacter = null;
        cleanupTest();
    });

    beforeEach(function () {
        setupTest(this.currentTest);
    });

    for (let rule of RULES.filter(r => r.inherits)) {

        describe(rule.attr, function () {

            it('own value, with or without :inherited', function () {
                assert.equal(read(rule, button('<div><button {A}="own">x</button></div>', rule.attr)), 'own');
                assert.equal(read(rule, button('<div><button {A}:inherited="own">x</button></div>', rule.attr)), 'own');
            });

            it('explicit :inherited reaches the child, over one and two levels, and the nearest wins', function () {
                assert.equal(read(rule, button('<div {A}:inherited="p"><button>x</button></div>', rule.attr)), 'p');
                assert.equal(read(rule, button('<div {A}:inherited="g"><div><button>x</button></div></div>', rule.attr)), 'g');
                assert.equal(read(rule, button('<div {A}:inherited="g"><div {A}:inherited="p"><button>x</button></div></div>', rule.attr)), 'p');
                assert.equal(read(rule, button('<div {A}:inherited="g"><button {A}="own">x</button></div>', rule.attr)), 'own');
            });

            it('a bare ancestor value is not inherited', function () {
                assert.equal(read(rule, button('<div {A}="p"><button>x</button></div>', rule.attr)), undefined);
                assert.equal(read(rule, button('<div {A}="g"><div><button>x</button></div></div>', rule.attr)), undefined);
            });

            it(':append adds to the inherited chain', function () {
                assert.equal(read(rule, button('<div {A}:inherited="a"><div {A}:inherited:append="b"><button {A}:append="c">x</button></div></div>', rule.attr)), 'a,b,c');
                assert.equal(read(rule, button('<div {A}:inherited="a"><button {A}:append="c">x</button></div>', rule.attr)), 'a,c');
                assert.equal(read(rule, button('<div><button {A}:append="c">x</button></div>', rule.attr)), 'c');
                assert.equal(read(rule, button('<div {A}:inherited:append="b"><button>x</button></div>', rule.attr)), 'b');
                assert.equal(read(rule, button('<div {A}="a"><button {A}:append="c">x</button></div>', rule.attr)), 'c');
            });

            it('every attribute spelling inherits', function () {
                for (let prefix of ['ypy-', 'data-ypy-']) {
                    let spelled = rule.attr.replace('ypy-', prefix);
                    assert.equal(read(rule, button('<div {A}:inherited="p"><button>x</button></div>', spelled)), 'p', spelled);
                    assert.equal(read(rule, button('<div {A}:inherited="a"><button {A}:append="c">x</button></div>', spelled)), 'a,c', spelled);
                }
            });

            it('a changed metaCharacter changes the modifiers, not the rule', function () {
                ypy.config.metaCharacter = '-';
                let attr = rule.attr.replace(/:/g, '-');
                assert.equal(read(rule, button('<div {A}-inherited="p"><button>x</button></div>', attr), rule.attr), 'p');
                assert.equal(read(rule, button('<div {A}-inherited="a"><button {A}-append="c">x</button></div>', attr), rule.attr), 'a,c');
                assert.equal(read(rule, button('<div {A}="p"><button>x</button></div>', attr), rule.attr), undefined);
            });
        });
    }
});

describe('attribute inheritance: the default value', function () {

    afterEach(function () {
        cleanupTest();
    });

    it('a bare ancestor value does not stop an :append chain from being read', function () {
        setupTest(this.test);
        let b = button('<div ypy-get="/g"><div ypy-get:inherited:append="p"><button>x</button></div></div>');
        assert.equal(ypy.__attributeValue(b, 'ypy-get'), 'p');
    });

    it('an ancestor without a value gives the default', function () {
        setupTest(this.test);
        let b = button('<div ypy-x="g"><button>x</button></div>');
        assert.equal(ypy.__attributeValue(b, 'ypy-x', 'fallback'), 'fallback');
        assert.equal(ypy.__attributeValue(b, 'ypy-x'), undefined);
    });

    it('the default is not used when an ancestor has the attribute', function () {
        setupTest(this.test);
        let b = button('<div ypy-x:inherited="g"><button>x</button></div>');
        assert.equal(ypy.__attributeValue(b, 'ypy-x', 'fallback'), 'g');
    });
});

describe('attribute inheritance: the collector sees each level', function () {

    afterEach(function () {
        cleanupTest();
    });

    it('ypy-include="this" is found on an ancestor only through :inherited', function () {
        setupTest(this.test);
        let c = createDisconnectedHTML('<div ypy-include:inherited="this"><div><button>x</button></div></div>');
        assert.deepEqual(ypy.__findThisElements(c.querySelector('button'), 'ypy-include'), [c]);
        let d = createDisconnectedHTML('<div ypy-include="this"><div><button>x</button></div></div>');
        assert.deepEqual(ypy.__findThisElements(d.querySelector('button'), 'ypy-include'), []);
    });

    it('the collector is called for each :append level, nearest first', function () {
        setupTest(this.test);
        let b = button('<div ypy-x:inherited="a"><div ypy-x:inherited:append="b"><button ypy-x:append="c">x</button></div></div>');
        let seen = [];
        ypy.__attributeValue(b, 'ypy-x', undefined, (val, elt) => { seen.push(val + '@' + elt.tagName); });
        assert.deepEqual(seen, ['c@BUTTON', 'b@DIV', 'a@DIV']);
    });
});

describe('attribute inheritance: whole requests', function () {

    beforeEach(function () {
        setupTest(this.currentTest);
    });

    afterEach(function () {
        cleanupTest();
    });

    it('ypy-target:inherited on a container sends the response to that target', async function () {
        mockResponse('GET', '/t', 'Done');
        createProcessedHTML('<div ypy-target:inherited="#out"><button id="btn" ypy-get="/t">go</button></div><div id="out"></div>');
        find('#btn').click();
        await forRequest();
        assert.equal(find('#out').innerText, 'Done');
        assert.equal(find('#btn').innerText, 'go');
    });

    it('ypy-target:inherited does the same', async function () {
        mockResponse('GET', '/t', 'Done');
        createProcessedHTML('<div ypy-target:inherited="#out"><button id="btn" ypy-get="/t">go</button></div><div id="out"></div>');
        find('#btn').click();
        await forRequest();
        assert.equal(find('#out').innerText, 'Done');
    });

    it('a bare ypy-target on a container is not inherited', async function () {
        mockResponse('GET', '/t', 'Done');
        createProcessedHTML('<div ypy-target="#out"><button id="btn" ypy-get="/t">go</button></div><div id="out"></div>');
        find('#btn').click();
        await forRequest();
        assert.equal(find('#out').innerText, '');
        assert.equal(find('#btn').innerText, 'Done');
    });

    it('ypy-vals:inherited and :append reach the request of a descendant', async function () {
        mockResponse('GET', '/t', 'Done');
        createProcessedHTML('<div ypy-vals:inherited=\'{"a":"1"}\'><button id="btn" ypy-get="/t" ypy-vals:append=\'{"b":"2"}\'>go</button></div>');
        find('#btn').click();
        await forRequest();
        let url = new URL(lastFetch().url, location.href);
        assert.equal(url.searchParams.get('a'), '1');
        assert.equal(url.searchParams.get('b'), '2');
    });
});

describe('attribute inheritance: the table in the documentation is the list in code', function () {

    // fetch is replaced by the mock in this suite, so the files are read with a plain request
    function source(path) {
        return new Promise((resolve, reject) => {
            let xhr = new XMLHttpRequest();
            xhr.open('GET', path);
            xhr.onload = () => xhr.status === 200 ? resolve(xhr.responseText) : reject(new Error(path + ' ' + xhr.status));
            xhr.onerror = () => reject(new Error(path));
            xhr.send();
        });
    }

    it('the attributes the list marks as element-only are not read through __attributeValue', async function () {
        let src = await source('/src/ypy.js');
        for (let rule of RULES.filter(r => !r.inherits)) {
            let re = new RegExp('__attributeValue\\([^\\n]*["\']' + rule.attr + '["\']');
            assert.isFalse(re.test(src), rule.attr);
        }
    });
});
