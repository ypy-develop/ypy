// SPDX-License-Identifier: MIT
describe('__getAttributeObject unit tests', function() {

    // These tests run author code (ypy-on, js: values, [filter]), which config.callbacks must allow
    beforeEach(function() { ypy.config.callbacks = 'all' })
    afterEach(function() { delete ypy.config.callbacks })

    async function getObj(elt, attr) {
        let result = null;
        let p = ypy.__getAttributeObject(elt, attr, obj => { result = obj; });
        if (p) await p;
        return result;
    }

    it('handles basic key-value pairs', async function () {
        let btn = createProcessedHTML('<button ypy-vals="foo:bar">Click</button>')
        let obj = await getObj(btn, 'ypy-vals')
        assert.equal(obj.foo, 'bar')
    })

    it('handles multiple key-value pairs with correct types', async function () {
        let btn = createProcessedHTML('<button ypy-vals="a:1, b:2, c:3">Click</button>')
        let obj = await getObj(btn, 'ypy-vals')
        assert.equal(obj.a, 1)
        assert.equal(obj.b, 2)
        assert.equal(obj.c, 3)
    })

    it('handles JSON object', async function () {
        let btn = createProcessedHTML('<button ypy-vals=\'{"foo":"bar","baz":"qux"}\'>Click</button>')
        let obj = await getObj(btn, 'ypy-vals')
        assert.equal(obj.foo, 'bar')
        assert.equal(obj.baz, 'qux')
    })

    it('returns null with no attribute', function () {
        let btn = createProcessedHTML('<button>Click</button>')
        assert.equal(ypy.__getAttributeObject(btn, 'ypy-vals', () => {}), null)
    })

    it('handles quoted string values', async function () {
        let btn = createProcessedHTML("<button ypy-vals='name:\"John Doe\", age:30'>Click</button>")
        let obj = await getObj(btn, 'ypy-vals')
        assert.equal(obj.name, 'John Doe')
        assert.equal(obj.age, 30)
    })

    it('handles js: prefix with object return', async function () {
        let btn = createProcessedHTML("<button ypy-vals=\"js:{foo: 'bar', num: 42}\">Click</button>")
        let obj = await getObj(btn, 'ypy-vals')
        assert.equal(obj.foo, 'bar')
        assert.equal(obj.num, 42)
    })

    it('handles js: prefix with dynamic values', async function () {
        window.testValue = 'dynamic'
        let btn = createProcessedHTML('<button ypy-vals="js:{key: window.testValue}">Click</button>')
        let obj = await getObj(btn, 'ypy-vals')
        assert.equal(obj.key, 'dynamic')
        delete window.testValue
    })

    it('handles javascript: prefix', async function () {
        let btn = createProcessedHTML("<button ypy-vals=\"javascript:{foo: 'baz'}\">Click</button>")
        let obj = await getObj(btn, 'ypy-vals')
        assert.equal(obj.foo, 'baz')
    })

    it('handles js: prefix with element access', async function () {
        let container = createProcessedHTML('<div><input id="myinput" value="test"><button ypy-vals="js:{val: document.getElementById(\'myinput\').value}">Click</button></div>')
        let btn = container.querySelector('button')
        let obj = await getObj(btn, 'ypy-vals')
        assert.equal(obj.val, 'test')
    })

    it('preserves boolean types', async function () {
        let btn = createProcessedHTML('<button ypy-vals="enabled:true, disabled:false">Click</button>')
        let obj = await getObj(btn, 'ypy-vals')
        assert.equal(obj.enabled, true)
        assert.equal(obj.disabled, false)
    })

    it('preserves numeric types', async function () {
        let btn = createProcessedHTML('<button ypy-vals="count:123, price:456">Click</button>')
        let obj = await getObj(btn, 'ypy-vals')
        assert.equal(obj.count, 123)
        assert.equal(obj.price, 456)
    })

});
