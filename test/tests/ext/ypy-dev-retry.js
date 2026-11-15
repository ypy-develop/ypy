// SPDX-License-Identifier: MIT
// TASK-051: the simulators of ypy-dev when ypy-retry registered first (ypy-retry replaces ctx.fetch
// with an accessor; the simulator has to sit inside its loop, not around it).
describe('ypy-dev after ypy-retry', function () {

    before(async () => {
        for (let name of ['ypy-retry', 'ypy-dev']) {
            let script = document.createElement('script');
            script.src = `../src/ext/${name}.js`;
            await new Promise(resolve => {
                script.onload = resolve;
                document.head.appendChild(script);
            });
        }
        assert.isObject(ypy.dev);
    });

    beforeEach(function () {
        setupTest(this.currentTest);
    });

    afterEach(function () {
        ypy.dev.offline(false);
        ypy.dev.latency(0);
        cleanupTest();
    });

    it('offline: every attempt fails inside the retry loop and the request gives up', async function () {
        ypy.dev.offline(true);
        mockResponse('GET', '/x', 'done');
        createProcessedHTML('<button ypy-get="/x" ypy-retry="attempts:2 delay:10ms">Go</button>');
        let retries = 0;
        document.addEventListener('ypy:request:retry', () => retries++);
        find('button').click();
        await forRequest(1000);
        assert.equal(retries, 2);
        assert.equal(fetchMock.getLastCall(), undefined, 'no attempt reached fetch');
    });

    it('latency: the delay applies to a request that succeeds and does not loop forever', async function () {
        ypy.dev.latency(60);
        mockResponse('GET', '/x', 'done');
        createProcessedHTML('<button ypy-get="/x" ypy-target="#out" ypy-swap="innerHTML" ypy-retry="attempts:2">Go</button><div id="out"></div>');
        let t = performance.now();
        find('button').click();
        await forRequest(1000);
        assert.isAtLeast(performance.now() - t, 50);
        assert.equal(find('#out').textContent, 'done');
        assert.equal(fetchMock.getCalls().length, 1);
    });
});
