// SPDX-License-Identifier: MIT
// A browser may refuse a history write: Safari throws a SecurityError past 100 writes in 10
// seconds. The page is still swapped, nothing throws, and the next write works again.
describe('a history write the browser refuses', function () {
    let realPush, realReplace, refused;

    function refuse() {
        refused = {push: 0, replace: 0};
        history.pushState = () => { refused.push++; throw new DOMException('Attempt to use history.pushState() more than 100 times per 10 seconds', 'SecurityError'); };
        history.replaceState = () => { refused.replace++; throw new DOMException('Attempt to use history.replaceState() more than 100 times per 10 seconds', 'SecurityError'); };
    }

    function allow() {
        history.pushState = realPush;
        history.replaceState = realReplace;
    }

    beforeEach(function () {
        setupTest(this.currentTest);
        realPush = history.pushState;
        realReplace = history.replaceState;
    });

    afterEach(function () {
        allow();
        cleanupTest();
    });

    it('still swaps the page on ypy-push-url and does not announce a push that did not happen', async function () {
        mockResponse('GET', '/refused-push', 'pushed');
        let pushed = [];
        let onPush = e => pushed.push(e.detail.path);
        document.addEventListener('ypy:after:history:push', onPush);
        let before = location.href;
        try {
            let btn = createProcessedHTML('<button ypy-get="/refused-push" ypy-push-url="true">go</button>');
            refuse();
            btn.click();
            await forRequest();
            allow();
            playground().textContent.should.contain('pushed');
            refused.push.should.be.above(0);
            pushed.should.deep.equal([]);
            location.href.should.equal(before);
        } finally {
            document.removeEventListener('ypy:after:history:push', onPush);
        }
    });

    it('still swaps the page on ypy-replace-url', async function () {
        mockResponse('GET', '/refused-replace', 'replaced');
        let btn = createProcessedHTML('<button ypy-get="/refused-replace" ypy-replace-url="true">go</button>');
        refuse();
        btn.click();
        await forRequest();
        allow();
        playground().textContent.should.contain('replaced');
        refused.replace.should.be.above(0);
    });

    it('pushes again once the browser accepts writes', async function () {
        mockResponse('GET', '/refused-first', 'first');
        mockResponse('GET', '/accepted-second', 'second');
        let btn = createProcessedHTML('<button ypy-get="/refused-first" ypy-push-url="true">one</button>');
        refuse();
        btn.click();
        await forRequest();
        allow();
        let btn2 = createProcessedHTML('<button ypy-get="/accepted-second" ypy-push-url="true">two</button>');
        btn2.click();
        await forRequest();
        playground().textContent.should.contain('second');
        location.pathname.should.equal('/accepted-second');
    });
});
