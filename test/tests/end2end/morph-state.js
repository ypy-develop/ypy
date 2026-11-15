// SPDX-License-Identifier: MIT
// TASK-007: a swap that gives no style morphs, and what the user did to the
// page survives a response that repeats the HTML and one that changes it.
describe('Morph keeps the live state of the page', function() {

    let reply;

    beforeEach(function() {
        setupTest(this);
        mockResponse('GET', '/t', () => new MockResponse(reply));
    });

    afterEach(function() {
        cleanupTest();
    });

    // the request is made by a button outside the box; the box is swapped with the default style
    function mount(inner) {
        createProcessedHTML('<div><button id="b" ypy-get="/t" ypy-target="#box">go</button><div id="box">' + inner + '</div></div>');
    }

    async function refresh(html) {
        reply = html;
        find('#b').click();
        await forRequest();
    }

    // each state is checked after a response that repeats the HTML and after one that changes it
    function bothResponses(name, inner, changed, act, check) {
        for (let [kind, response] of [['repeats', inner], ['changes', changed]]) {
            it(name + ', response that ' + kind + ' the HTML', async function() {
                mount(inner);
                let state = await act.call(this);
                await refresh(response);
                await check(state, kind);
            });
        }
    }

    bothResponses('keeps a details open',
        '<details id="d"><summary>more</summary><p>text</p></details>',
        '<details id="d" class="seen"><summary>more</summary><p>other text</p></details>',
        () => { find('#d').open = true; return find('#d'); },
        (d, kind) => {
            assert.equal(find('#d'), d);
            assert.isTrue(d.open);
            if (kind === 'changes') assert.equal(d.textContent, 'moreother text');
        });

    bothResponses('keeps a details closed',
        '<details id="d" open><summary>more</summary><p>text</p></details>',
        '<details id="d" class="seen" open><summary>more</summary><p>other text</p></details>',
        () => { find('#d').open = false; return find('#d'); },
        d => {
            assert.equal(find('#d'), d);
            assert.isFalse(d.open);
        });

    bothResponses('keeps a non-modal dialog open',
        '<dialog id="dlg"><p>hello</p></dialog>',
        '<dialog id="dlg" class="seen"><p>hello again</p></dialog>',
        () => { find('#dlg').show(); return find('#dlg'); },
        (dlg, kind) => {
            assert.equal(find('#dlg'), dlg);
            assert.isTrue(dlg.open);
            if (kind === 'changes') assert.equal(dlg.textContent, 'hello again');
        });

    bothResponses('keeps a modal dialog modal',
        '<dialog id="dlg"><p>hello</p></dialog>',
        '<dialog id="dlg" class="seen"><p>hello again</p></dialog>',
        () => { find('#dlg').showModal(); return find('#dlg'); },
        dlg => {
            try {
                assert.equal(find('#dlg'), dlg);
                assert.isTrue(dlg.matches(':modal'));
            } finally {
                dlg.close();
            }
        });

    bothResponses('keeps the text typed in an input',
        '<label>Name <input id="name" value=""></label>',
        '<label class="seen">Name <input id="name" value="" placeholder="your name"></label>',
        () => { let i = find('#name'); i.value = 'Ada Lovelace'; return i; },
        (i, kind) => {
            assert.equal(find('#name'), i);
            assert.equal(i.value, 'Ada Lovelace');
            if (kind === 'changes') assert.equal(i.placeholder, 'your name');
        });

    bothResponses('keeps the text typed in a textarea',
        '<textarea id="note">draft</textarea>',
        '<textarea id="note" rows="4">draft</textarea>',
        () => { let t = find('#note'); t.value = 'draft plus what I typed'; return t; },
        (t, kind) => {
            assert.equal(find('#note'), t);
            assert.equal(t.value, 'draft plus what I typed');
            if (kind === 'changes') assert.equal(t.rows, 4);
        });

    bothResponses('keeps the choice made in a select',
        '<select id="s"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>',
        '<select id="s" class="seen"><option value="a">A</option><option value="b">B</option><option value="c">C</option><option value="d">D</option></select>',
        () => { let s = find('#s'); s.value = 'c'; return s; },
        (s, kind) => {
            assert.equal(find('#s'), s);
            assert.equal(s.value, 'c');
            if (kind === 'changes') assert.equal(s.options.length, 4);
        });

    bothResponses('keeps a checkbox the user changed',
        '<input id="ck" type="checkbox"><input id="ck2" type="checkbox" checked>',
        '<input id="ck" type="checkbox" class="seen"><input id="ck2" type="checkbox" class="seen" checked>',
        () => { find('#ck').checked = true; find('#ck2').checked = false; return find('#ck'); },
        (ck, kind) => {
            assert.equal(find('#ck'), ck);
            assert.isTrue(find('#ck').checked);
            assert.isFalse(find('#ck2').checked);
            if (kind === 'changes') assert.equal(ck.className, 'seen');
        });

    bothResponses('keeps the radio button the user chose',
        '<input id="r1" type="radio" name="r" value="1" checked><input id="r2" type="radio" name="r" value="2">',
        '<input id="r1" type="radio" name="r" value="1" checked class="seen"><input id="r2" type="radio" name="r" value="2" class="seen">',
        () => { find('#r2').checked = true; return find('#r2'); },
        (r2, kind) => {
            assert.equal(find('#r2'), r2);
            assert.isTrue(r2.checked);
            assert.isFalse(find('#r1').checked);
            if (kind === 'changes') assert.equal(r2.className, 'seen');
        });

    bothResponses('keeps the focus and the selection',
        '<p>intro</p><input id="f" value="abcdef">',
        '<p>a longer intro, so the input moves</p><p>and another one</p><input id="f" value="abcdef" class="seen">',
        () => { let i = find('#f'); i.focus(); i.setSelectionRange(2, 4); return i; },
        (i, kind) => {
            assert.equal(find('#f'), i);
            assert.equal(document.activeElement, i);
            assert.equal(i.selectionStart, 2);
            assert.equal(i.selectionEnd, 4);
            if (kind === 'changes') assert.equal(i.className, 'seen');
        });

    bothResponses('keeps the focus on a field without an id',
        '<form><input name="q" value="x"></form>',
        '<form class="seen"><input name="q" value="x" class="wide"></form>',
        () => { let i = find('input'); i.focus(); return i; },
        (i, kind) => {
            assert.equal(find('input'), i);
            assert.equal(document.activeElement, i);
        });

    bothResponses('keeps the scroll position of a block',
        '<div id="sc" style="height:50px;overflow:auto"><div style="height:500px">tall</div></div>',
        '<div id="sc" style="height:50px;overflow:auto" class="seen"><div style="height:500px">taller</div></div>',
        () => { let sc = find('#sc'); sc.scrollTop = 120; return sc; },
        (sc, kind) => {
            assert.equal(find('#sc'), sc);
            assert.equal(sc.scrollTop, 120);
            if (kind === 'changes') assert.equal(sc.className, 'seen');
        });

    bothResponses('keeps a video playing',
        '<video id="v" muted loop playsinline width="40" height="30"></video>',
        '<video id="v" muted loop playsinline width="40" height="30" class="seen"></video>',
        async function() {
            let canvas = document.createElement('canvas');
            canvas.width = 40; canvas.height = 30;
            canvas.getContext('2d').fillRect(0, 0, 40, 30);
            let video = find('#v');
            video.srcObject = canvas.captureStream(10);
            try {
                await video.play();
            } catch (e) {
                this.skip();
            }
            return video;
        },
        (video, kind) => {
            assert.equal(find('#v'), video);
            assert.isFalse(video.paused);
            assert.isNotNull(video.srcObject);
            if (kind === 'changes') assert.equal(video.className, 'seen');
        });

    it('lets the response close a details that it marks with ypy-morph-force', async function() {
        mount('<details id="d" open><summary>more</summary></details>');
        await refresh('<details id="d" ypy-morph-force><summary>more</summary></details>');
        assert.isFalse(find('#d').open);
    });

    it('lets the response change the text of the field that has the focus when it forces it', async function() {
        mount('<input id="f" value="a">');
        let i = find('#f');
        i.focus();
        i.value = 'typed';
        await refresh('<input id="f" value="from the server" ypy-morph-force>');
        assert.equal(i.value, 'from the server');
    });

    it('shows what the server changed in a field the user did not touch', async function() {
        mount('<input id="f" value="a">');
        await refresh('<input id="f" value="b">');
        assert.equal(find('#f').value, 'b');
    });

    it('survives many refreshes without losing the state', async function() {
        mount('<details id="d"><summary>more</summary></details><input id="f" value="">');
        find('#d').open = true;
        find('#f').value = 'kept';
        for (let n = 0; n < 20; n++) {
            await refresh('<details id="d"><summary>more</summary><p>' + n + '</p></details><input id="f" value="">');
        }
        assert.isTrue(find('#d').open);
        assert.equal(find('#f').value, 'kept');
        assert.equal(find('#d p').textContent, '19');
    });

    it('replaces the nodes when the swap is written as innerHTML', async function() {
        mount('<details id="d"><summary>more</summary></details>');
        let d = find('#d');
        d.open = true;
        find('#b').setAttribute('ypy-swap', 'innerHTML');
        ypy.process(find('#b').parentNode);
        await refresh('<details id="d"><summary>more</summary></details>');
        assert.notEqual(find('#d'), d);
        assert.isFalse(find('#d').open);
    });
});
