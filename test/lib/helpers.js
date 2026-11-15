if (typeof installFetchMock !== 'undefined') {
  installFetchMock()
}

//================================================================================
// Code to prevent accidental navigation
//================================================================================

let linkNavPreventer = (e) => {
  let anchor = e.target.closest('a');

  if (!anchor || !anchor.href) return;
  if (e.defaultPrevented) return;
  if (e.button !== 0) return; // Not left click
  if (e.ctrlKey || e.metaKey || e.shiftKey) return; // Modifier keys
  if (anchor.download) return;
  if (anchor.href.startsWith('javascript:')) return;
  if (anchor.href.startsWith('#')) return; // Hash only

  e.preventDefault();
  console.warn('Navigation prevented:', anchor.href, new Error().stack);
};

let submitPreventer = (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  console.warn('Form submission prevented:', e, new Error().stack);
};

//================================================================================
// Test life cycle helpers
//================================================================================

// can be enabled for a test by calling debug(this)
let testDebugging = false;

const savedUrl = window.location.href;
const DEFAULT_SWAP = ypy.config.defaultSwap;

// Author code (ypy-on, `js:` values, [filter] triggers) is off by default (config.callbacks is
// "none"). Most tests exercise it, so setupTest turns it on; a test of the policy itself, or of the
// default, opts out:
//   setupTest(this, {authorCode: false})
function setupTest(test, {authorCode = true} = {}) {
  if (authorCode) ypy.config.callbacks = 'all'; else delete ypy.config.callbacks;
  if (test) {
    console.log("RUNNING TEST: ", test.title);
  }
  if (!playground().hasAttribute("data-is-navsafe")) {
    // Catch anchor navigations
    playground().addEventListener('click', linkNavPreventer);
    // Catch form submissions
    playground().addEventListener('submit', submitPreventer);
    playground().setAttribute("data-is-navsafe", 'true')
  }
}

// True when the page loaded the source build, where the core's private members (__x) can be
// reached. In dist/ they are real private fields (`ypy test --dist`). A test that reads or calls
// one is written with itSource/describeSource: it runs against src/ and is reported as skipped
// against dist/. Everything else a test touches must be public API or the extension API.
const SOURCE_BUILD = typeof ypy.__cleanup === 'function';
function itSource(...args) { return (SOURCE_BUILD ? it : it.skip)(...args) }
function describeSource(...args) { return (SOURCE_BUILD ? describe : describe.skip)(...args) }

// Restores the history entry the page is on, as if the user had come back to it. The source build
// calls the core's restore with the given arguments. Against dist/ the restore is private, so the
// page goes forward to a throwaway entry and back again: the core's own listener (navigation
// traverse, or popstate) restores the entry with its state and its path, which are the current
// ones in every test that calls this.
async function restoreHistory(state, path) {
    if (SOURCE_BUILD) return ypy.__restoreHistory(state, path);
    history.pushState({}, '', '/__ypy-away__');
    await new Promise(resolve => {
        window.addEventListener('popstate', resolve, {once: true});
        history.back();
    });
}

function cleanupTest() {
    delete ypy.config.callbacks
    ypy.config.defaultSwap = DEFAULT_SWAP
    let pg = playground()
    if (pg && !testDebugging) {
        ypy.__cleanup?.(pg)
        pg.innerHTML = ''
    }
    testDebugging = false;
    if (typeof fetchMock !== 'undefined' && fetchMock.reset) {
        // Check for pending requests before cleaning up
        if (fetchMock.pendingRequests && fetchMock.pendingRequests.length > 0) {
            console.warn(`WARNING: Test is leaving ${fetchMock.pendingRequests.length} request(s) in flight. Tests should wait for all requests to complete.`);
        }
        fetchMock.reset()
    }
    let saved = new URL(savedUrl);
    if (location.pathname !== saved.pathname || location.search !== saved.search) {
        // Use location.replace() instead of history.replaceState() to avoid
        // the browser's 100 replaceState/10s rate limit across large test suites.
        // location.replace() navigates to the URL without adding a history entry
        // and is not subject to the replaceState rate limit.
        history.replaceState(null, '', savedUrl);
    }
}

//================================================================================
// Extension backup/restore helpers
//================================================================================

// Loads an extension script (a path as the tests write it, '../src/ext/ypy-x.js') and resolves when it ran.
function loadExtension(src) {
    return new Promise((resolve, reject) => {
        let script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

function backupExtensions() {
    if (!SOURCE_BUILD) return {};  // the registry is private in dist/: an extension stays registered
    return {
        extMethods: new Map(ypy.__extMethods),
        registeredExt: new Set(ypy.__registeredExt),
        approvedExt: ypy.__approvedExt
    };
}

function restoreExtensions(backup) {
    if (!SOURCE_BUILD) return;
    ypy.__extMethods = backup.extMethods;
    ypy.__registeredExt = backup.registeredExt;
    ypy.__approvedExt = backup.approvedExt;
}

function clearExtensions() {
    if (!SOURCE_BUILD) return;
    ypy.__extMethods.clear();
    ypy.__registeredExt.clear();
}

function debug(test) {
    test.timeout(0);
    testDebugging = true;
}

//================================================================================
// HTML creation helpers
//================================================================================

// This function processes the content immediately (rather than waiting for the mutation observer)
// Prefer using this function for testing!
function createProcessedHTML(innerHTML) {
  let pg = playground();
  if (pg) {
    pg.innerHTML = innerHTML
    ypy.process(pg)
  }
  return pg.firstElementChild
}

// This function waits for the mutation observer to process the new content
function createHTMLNoProcessing(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    const elt = div.firstElementChild;
    playground().appendChild(elt);
    return elt
}

// This function creates a disconnected node
function createDisconnectedHTML(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    const elt = div.firstElementChild;
    return elt
}

//================================================================================
// Fetch mock response helpers
//================================================================================

function mockResponse(action, pattern, response, options = {}) {
  fetchMock.mockResponse(action, pattern, response, options);
}

function mockFailure(action, pattern, message = 'Network failure') {
  fetchMock.mockFailure(action, pattern, message);
}

function mockSequentialResponses(method, urlPattern, response, options = {}) {
  return fetchMock.mockSequentialResponses(method, urlPattern, response, options);
}

function mockStreamResponse(url) {
  const controllers = [];
  const enc = new TextEncoder();

  // Return a fresh stream each time the URL is fetched
  fetchMock.mockResponse('GET', url, () => {
    let ctrl;
    const body = new ReadableStream({ start(c) { ctrl = c; controllers.push(c); } });
    const response = new MockResponse(body, {
      headers: { 'Content-Type': 'text/event-stream' }
    });
    response.body = body;
    return response;
  });

  return {
    send(data, event, id) {
      // Send to the most recent active controller
      const ctrl = controllers[controllers.length - 1];
      if (!ctrl) return;
      let msg = (event ? `event: ${event}\n` : '') + (id ? `id: ${id}\n` : '') + `data: ${data}\n\n`;
      ctrl.enqueue(enc.encode(msg));
    },
    sendRaw(raw) {
      const ctrl = controllers[controllers.length - 1];
      if (ctrl) ctrl.enqueue(enc.encode(raw));
    },
    close: () => {
      // Close the most recent controller
      const ctrl = controllers[controllers.length - 1];
      if (ctrl) ctrl.close();
    },
    error: (e) => {
      const ctrl = controllers[controllers.length - 1];
      if (ctrl) ctrl.error(e);
    }
  };
}

function lastFetch() {
    let lastCall = fetchMock.getLastCall();
    assert.isNotNull(lastCall, "No fetch call was made!")
    return lastCall;
}

//======================================================================
// General test helper utilities
//======================================================================

function waitForEvent(eventName, timeout = 200) {
  let ms = testDebugging ? 0 : timeout;
  return new Promise(resolve => {
    let h = evt => { clearTimeout(id); resolve(evt); };
    let id = ms && setTimeout(() => {
      document.removeEventListener(eventName, h);
      resolve(null);
    }, ms);
    document.addEventListener(eventName, h, { once: true });
  });
}

function forRequest(timeout = 200) {
  return waitForEvent("ypy:finally:request", timeout);
}

function forRequestWithDelay(timeout = 200) {
  return ypy.timeout(50).then(() => forRequest(timeout));
}

function playground() {
  return ypy.find("#test-playground");
}

function find(selector) {
  return ypy.find(playground(), selector)
}

// ==============================================================================
// Assertion Helpers
// ==============================================================================

function assertPropertyIs(css, property, content) {
  let elt = playground().querySelector(css);
  if (!elt) {
    assert.fail("Could not find element with css '" + css + "' in :\n\n" + playground().innerHTML + "\n\n")
  }
  assert.equal(elt[property], content)
}

function assertTextContentIs(css, content) {
  assertPropertyIs(css, 'textContent', content)
}
