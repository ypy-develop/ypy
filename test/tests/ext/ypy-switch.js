// SPDX-License-Identifier: MIT
describe('ypy-switch extension', function () {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-switch.js';
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

    afterEach(() => {
        cleanupTest();
    });

    const hidden = id => find('#' + id).hidden;
    const set = (id, value) => {
        let f = find('#' + id);
        f.value = value;
        f.dispatchEvent(new Event(f.tagName === 'SELECT' ? 'change' : 'input', {bubbles: true}));
    };
    const tick = () => ypy.timeout(5);

    const kindForm = (rule = 'kind=company') => createProcessedHTML(
        '<form id="f"><select id="kind" name="kind"><option value="person">Person</option><option value="company">Company</option><option value="ngo">NGO</option></select>' +
        `<div id="part" ypy-switch="${rule}"><input id="cnpj" name="cnpj" required></div></form>`);

    it('hides the part when the rule does not hold and shows it when it does', function () {
        kindForm();
        assert.isTrue(hidden('part'));
        set('kind', 'company');
        assert.isFalse(hidden('part'));
        set('kind', 'person');
        assert.isTrue(hidden('part'));
    });

    it('sends no request', async function () {
        kindForm();
        set('kind', 'company');
        await tick();
        assert.equal(fetchMock.getCalls().length, 0);
    });

    it('takes a list of values with |', function () {
        kindForm('kind=company|ngo');
        assert.isTrue(hidden('part'));
        set('kind', 'ngo');
        assert.isFalse(hidden('part'));
        set('kind', 'company');
        assert.isFalse(hidden('part'));
    });

    it('takes != as "none of these values"', function () {
        kindForm('kind!=person');
        assert.isTrue(hidden('part'), 'person is the first option and is selected');
        set('kind', 'company');
        assert.isFalse(hidden('part'));
    });

    it('with no value, the part is shown when the field has one', function () {
        createProcessedHTML('<form><input id="code" name="code"><div id="part" ypy-switch="code"><input name="extra"></div></form>');
        assert.isTrue(hidden('part'));
        set('code', 'x');
        assert.isFalse(hidden('part'));
        set('code', '');
        assert.isTrue(hidden('part'));
    });

    it('follows a checkbox: with no value it means checked, and the value is "on"', function () {
        createProcessedHTML('<form><input id="nl" type="checkbox" name="news"><div id="p1" ypy-switch="news"></div><div id="p2" ypy-switch="news=on"></div><div id="p3" ypy-switch="news!=on"></div></form>');
        assert.isTrue(hidden('p1'));
        assert.isTrue(hidden('p2'));
        assert.isFalse(hidden('p3'));
        find('#nl').click();
        assert.isFalse(hidden('p1'));
        assert.isFalse(hidden('p2'));
        assert.isTrue(hidden('p3'));
    });

    it('follows a radio group by the checked one', function () {
        createProcessedHTML('<form><input id="r1" type="radio" name="pay" value="card" checked><input id="r2" type="radio" name="pay" value="pix"><div id="card" ypy-switch="pay=card"></div><div id="pix" ypy-switch="pay=pix"></div></form>');
        assert.isFalse(hidden('card'));
        assert.isTrue(hidden('pix'));
        find('#r2').click();
        assert.isTrue(hidden('card'));
        assert.isFalse(hidden('pix'));
    });

    it('lets any chosen option of a multiple select match', function () {
        createProcessedHTML('<form><select id="m" name="m" multiple><option value="a">a<option value="b">b<option value="c">c</select><div id="part" ypy-switch="m=c"></div></form>');
        assert.isTrue(hidden('part'));
        find('#m').options[0].selected = true;
        find('#m').options[2].selected = true;
        find('#m').dispatchEvent(new Event('change', {bubbles: true}));
        assert.isFalse(hidden('part'));
    });

    it('disables the fields of a hidden part, so they are not submitted and do not block the submit', function () {
        kindForm();
        let f = find('#f');
        assert.isTrue(find('#cnpj').disabled);
        assert.isFalse(new FormData(f).has('cnpj'));
        assert.isTrue(f.checkValidity(), 'the required field is out of the way');
        set('kind', 'company');
        assert.isFalse(find('#cnpj').disabled);
        assert.isFalse(f.checkValidity(), 'and counts again once the part is shown');
    });

    it('does not enable a field the page had disabled', function () {
        createProcessedHTML('<form><input id="x" name="x" value="a"><div id="part" ypy-switch="x=a"><input id="locked" name="locked" disabled><input id="free" name="free"></div></form>');
        assert.isFalse(hidden('part'));
        set('x', 'b');
        assert.isTrue(hidden('part'));
        set('x', 'a');
        assert.isTrue(find('#locked').disabled);
        assert.isFalse(find('#free').disabled);
    });

    it('keeps the fields of a nested part disabled while the outer part is hidden', function () {
        createProcessedHTML(
            '<form><input id="a" name="a" value="1"><input id="b" name="b" value="1">' +
            '<div id="outer" ypy-switch="a=1"><div id="inner" ypy-switch="b=1"><input id="deep" name="deep"></div></div></form>');
        assert.isFalse(find('#deep').disabled);
        set('a', '2');
        assert.isTrue(hidden('outer'));
        assert.isTrue(find('#deep').disabled);
        set('b', '2');
        set('b', '1');
        assert.isTrue(find('#deep').disabled, 'the inner part holds, the outer one does not');
        set('a', '1');
        assert.isFalse(find('#deep').disabled);
        set('b', '2');
        assert.isTrue(find('#deep').disabled);
        assert.isFalse(hidden('outer'));
    });

    it('fires ypy:switch when the part changes, and not for its first evaluation', function () {
        let seen = [];
        document.addEventListener('ypy:switch', e => seen.push(e.detail.shown));
        kindForm();
        assert.deepEqual(seen, []);
        set('kind', 'company');
        set('kind', 'ngo');
        set('kind', 'person');
        assert.deepEqual(seen, [true, false]);
    });

    it('looks for the field in the form of the part: another form is not read', function () {
        createProcessedHTML('<div><form><input name="kind" id="k1" value="company"><div id="p1" ypy-switch="kind=company"></div></form><form><input name="kind" id="k2" value="person"><div id="p2" ypy-switch="kind=company"></div></form></div>');
        assert.isFalse(hidden('p1'));
        assert.isTrue(hidden('p2'));
        set('k2', 'company');
        assert.isFalse(hidden('p2'));
        set('k1', 'x');
        assert.isTrue(hidden('p1'));
        assert.isFalse(hidden('p2'));
    });

    it('works with no form: the field is looked for in the page', function () {
        createProcessedHTML('<div><input id="q" name="q" value="x"><div id="part" ypy-switch="q=x"></div></div>');
        assert.isFalse(hidden('part'));
        set('q', 'y');
        assert.isTrue(hidden('part'));
    });

    it('evaluates a part that arrives in a swap, and the parts of the form it joined', async function () {
        mockResponse('GET', '/more', '<div id="late" ypy-switch="kind=company"><input name="late-field"></div>');
        createProcessedHTML('<form><select id="kind" name="kind"><option value="person">p<option value="company" selected>c</select><div id="slot"></div><button id="b" type="button" ypy-get="/more" ypy-target="#slot">go</button></form>');
        find('#b').click();
        await forRequest();
        assert.isFalse(hidden('late'));
        set('kind', 'person');
        assert.isTrue(hidden('late'));
    });

    it('follows a form reset', async function () {
        kindForm();
        set('kind', 'company');
        assert.isFalse(hidden('part'));
        find('#f').reset();
        await tick();
        assert.isTrue(hidden('part'));
    });

    it('ypy.switch.update() follows a value set by a script', function () {
        kindForm();
        find('#kind').value = 'company';
        assert.isTrue(hidden('part'));
        ypy.switch.update();
        assert.isFalse(hidden('part'));
    });

    it('leaves a part with a rule it cannot read shown', function () {
        createProcessedHTML('<form><div id="part" ypy-switch=""><input name="x"></div></form>');
        assert.isFalse(hidden('part'));
    });
});
