// SPDX-License-Identifier: MIT
//==========================================================
// ypy-download.js
//
// An extension that triggers a file download instead of a
// DOM swap, with streaming progress events for progress bars.
//
// Activates when:
//   - ypy-swap="download" is set on the element
//   - server responds with Content-Disposition: attachment
//   - server responds with YPY-Download: <url> (fetches that
//     url as the download, useful when the backend cannot
//     stream the file directly as the YPY response)
//
// Usage:
//   <button ypy-get="/file.pdf" ypy-swap="download"
//           ypy-ext="download">Download</button>
//
// Events:
//   ypy:download:start    {total, ctx}
//   ypy:download:progress {loaded, total, percent, ctx}
//   ypy:download:complete {filename, size, ctx}
//==========================================================
(() => {
    let api;

    ypy.registerExtension('ypy-download', {
        init: (internalAPI) => {
            api = internalAPI;
        },
        ypy_before_response: (elt, {ctx}) => {
            let downloadUrl = ctx.response.headers.get('YPY-Download');
            if (downloadUrl) {
                // same pin as every request (config.mode: a URL on another origin is refused by the browser); a
                // failure is reported as ypy:error instead of an unhandled rejection
                (async () => streamDownload(ctx, await fetch(downloadUrl, {mode: ypy.config.mode, credentials: 'same-origin'}), downloadUrl))()
                    .catch(error => api.triggerEvent(elt, 'ypy:error', {ctx, error}));
                return;
            }
            let cd = ctx.response.headers.get('Content-Disposition');
            if (ctx.swap !== 'download' && !cd?.includes('attachment')) return;
            // a download has no fixed duration, so drop the request timeout and
            // hand core a promise so it holds the request until we finish
            clearTimeout(ctx.requestTimeout);
            ctx.extensionPromise = streamDownload(ctx, ctx.response.raw, ctx.request.action);
            return false;
        }
    });

    function streamDownload(ctx, response, url) {
        let sourceElement = ctx.sourceElement;
        return (async () => {
            let total = +response.headers.get('Content-Length') || null;
            api.triggerEvent(sourceElement, 'ypy:download:start', {total, ctx});
            let reader = response.body.getReader();
            let chunks = [], loaded = 0;
            while (true) {
                let {done, value} = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.length;
                api.triggerEvent(sourceElement, 'ypy:download:progress', {
                    loaded, total, ctx,
                    percent: total ? Math.round(loaded / total * 100) : null
                });
            }
            let blob = new Blob(chunks, {
                type: response.headers.get('Content-Type') || 'application/octet-stream'
            });
            let filename = parseFilename(response.headers, url);
            let blobUrl = URL.createObjectURL(blob);
            Object.assign(document.createElement('a'), {href: blobUrl, download: filename}).click();
            URL.revokeObjectURL(blobUrl);
            api.triggerEvent(sourceElement, 'ypy:download:complete', {filename, size: blob.size, ctx});
        })();
    }

    function parseFilename(headers, url) {
        let cd = headers.get('Content-Disposition');
        if (cd) {
            // RFC 6266 / 5987: filename*=UTF-8''... takes precedence over filename=
            let star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
            if (star) {
                let raw = star[1].trim().replace(/^["']|["']$/g, '');
                try { return decodeURIComponent(raw); } catch { /* fall through */ }
            }
            let ascii = cd.match(/filename\s*=\s*(?:UTF-8'')?(?:"([^"]+)"|([^;]+))/i);
            if (ascii) return (ascii[1] || ascii[2]).trim();
        }
        return url.split('/').pop().split('?')[0] || 'download';
    }
})();
