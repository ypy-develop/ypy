// SPDX-License-Identifier: MIT
//==========================================================
// ypy-validate.js
//
// Field validation on the server for ypy: when the user leaves a field, the form's values go to a
// validation URL and the answer is shown next to the field. The form itself is never submitted.
//
// ypy-validate on a field turns it on. Its value is the URL to ask; a bare attribute asks the
// action of the form (ypy-post, ypy-action or action). ypy-validate="true" and ="false" keep their
// meaning in the core (the browser's own constraint check before a submit) and are not read here.
// ypy-validate-fields on a form, or on any element around fields, does the same for every field
// inside (a field with ypy-validate="false" is left out). ypy-validate-trigger, on the field or on
// the element that has ypy-validate-fields, changes when to ask (a trigger specification, default
// `change delay:200ms`: after the value changed, debounced).
//
// The request is a POST with every value of the form, so a rule can compare fields, and the header
// YPY-Validate with the name of the field. The server must check that header before it does
// anything else, and answer without saving: 422 with the message markup when the field is invalid,
// 204 or an empty 200 when it is valid. A 200 with a body shows that body (for example "available").
//
// Where the answer goes follows the core's error convention. ypy-error-target on the field names
// the place (a selector with the extended forms); without it the extension uses #<id>-error, and
// creates that element after the field when the page has none. ypy-error-swap (default innerHTML)
// and ypy-error-focus (default: the focus stays where the user is) are read from the field. The
// field gets aria-invalid="true" and aria-describedby pointing at the place on a 422, and loses
// aria-invalid when the field is valid. Any other error status is ignored: the form validates again
// when it is submitted.
//
// A new answer for a field cancels the one in flight, and a request sent by the form cancels the
// field requests of that form. Fields that arrive later are wired when their container is
// processed, a swap included.
//
// Batches. ypy-validate-batch on a field, on the element with ypy-validate-fields or on the form
// (the nearest one wins; the value is a time, a bare attribute means 50ms, false is off), or
// ypy.config.validate.batch, turns it on: the fields of one form that ask the same URL within
// that window go in one request, with YPY-Validate: field1,field2 (the names, in the order they
// asked). It is off by default, because the server must read the list. The answer: 422 when any
// field is invalid, 2xx when none is. The message of each invalid field comes as an
// out-of-band element whose id is the id of that field's place, for example
// `<small id="email-error" ypy-swap-oob="innerHTML">Taken</small>`; a field that has none is
// valid, and its place is emptied. aria-invalid and aria-describedby follow what each place
// shows. One field alone is checked as before, with the usual answer. If a field of a batch
// that is still in flight asks again, the request starts over with the whole batch.
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// Usage:
//   <form ypy-post="/signup" ypy-validate-fields="/signup/validate">
//     <input name="email" id="email" type="email">
//     <small id="email-error"></small>
//   </form>
//==========================================================
(() => {

    let api, count = 0;
    const FIELDS = 'input,select,textarea';
    const flight = new WeakMap();   // field -> AbortController of its request (.fields: those of the batch)
    const groups = [];              // fields waiting for the end of a batch window: {form, url, fields}

    // The URL to ask for a field, or undefined when the field is not validated.
    function urlFor(field) {
        let own = api.attr(field, 'ypy-validate'), host = field.closest(api.prefixSelector('[ypy-validate-fields]'));
        let url = own != null && own !== 'true' && own !== 'false' ? own : own !== 'false' && host ? api.attr(host, 'ypy-validate-fields') : null;
        if (url == null) return;
        if (url) return url;
        let form = field.form;
        return form && (api.determineMethodAndAction(form, {}).action || form.getAttribute('action')) || location.pathname + location.search;
    }

    // The element that shows the answer: the one the field names, else #<id>-error (made when missing).
    function errorBox(field) {
        let sel = api.attr(field, 'ypy-error-target'), box = sel && ypy.find(field, sel);
        if (box) return box;
        let id = (field.id || field.name || 'field' + ++count) + '-error';
        if (!(box = document.getElementById(id))) {
            box = document.createElement('div');
            box.id = id;
            box.className = 'ypy-field-error';
            box.setAttribute('aria-live', 'polite');
            field.after(box);
        }
        return box;
    }

    // Asks the URL for the fields, in one request, and shows each answer in its place.
    function send(fields, url) {
        for (let f of fields) flight.get(f)?.abort();
        let abort = new AbortController(), boxes = fields.map(errorBox);
        abort.fields = fields;
        for (let f of fields) flight.set(f, abort);
        ypy.ajax('POST', url, {
            source: fields[0], target: boxes[0], swap: fields[1] ? 'none' : 'innerHTML',
            headers: {'YPY-Validate': fields.map(f => f.name || f.id).join(',')},
            request: {signal: abort.signal}, fieldValidation: {field: fields[0], box: boxes[0], fields, boxes, abort}
        }).catch(() => {});
    }

    // The window of a field's batch in ms, or 0 for none.
    function batchWindow(field) {
        let host = field.closest(api.prefixSelector('[ypy-validate-batch]')), v = host ? api.attr(host, 'ypy-validate-batch') : ypy.config.validate?.batch;
        return v === false || v === 'false' || v == null ? 0 : v === '' || v === true || v === 'true' ? 50 : ypy.parseInterval(v);
    }

    function flush(group) {
        groups.splice(groups.indexOf(group), 1);
        let fields = [...group.fields].filter(f => f.isConnected && (f.name || f.id));
        if (fields.length) send(fields, group.url);
    }

    function validate(field) {
        let url = urlFor(field), ms = url != null && batchWindow(field);
        if (url == null || !(field.name || field.id) || !field.isConnected) return;
        if (!ms) return send([field], url);
        let group = groups.find(g => g.form === field.form && g.url === url);
        if (!group) {
            group = {form: field.form, url, fields: new Set()};
            group.timer = setTimeout(flush, ms, group);
            groups.push(group);
        }
        group.fields.add(field);
        // a batch of the field that is still in flight starts over with it
        flight.get(field)?.fields.forEach(f => group.fields.add(f));
    }

    function wire(field) {
        if (urlFor(field) == null) return;
        let state = api.ypyProp(field);
        if (state.validate) return;
        state.validate = true;
        let host = field.closest(api.prefixSelector('[ypy-validate-fields]'));
        api.onTrigger(field, api.attr(field, 'ypy-validate-trigger') || host && api.attr(host, 'ypy-validate-trigger') || 'change delay:200ms', () => validate(field));
    }

    // Wires the fields of a processed subtree: the ones that name a URL, and those in a container that does.
    function scan(root) {
        let fields = new Set(), selector = api.prefixSelector('[ypy-validate],[ypy-validate-fields]');
        let add = e => e.matches?.(FIELDS) ? fields.add(e) : e.querySelectorAll?.(FIELDS).forEach(f => fields.add(f));
        for (let e of [root, ...root.querySelectorAll?.(selector) ?? []]) if (e.matches?.(selector)) add(e);
        if (root.closest?.(api.prefixSelector('[ypy-validate-fields]'))) add(root);
        fields.forEach(wire);
    }

    ypy.registerExtension('ypy-validate', {

        init: (internalApi) => { api = internalApi },

        ypy_after_process: (elt) => { scan(elt) },

        // a request of the form (its own submit) outranks the field checks that are still running
        ypy_before_request: (elt, {ctx}) => {
            if (ctx.fieldValidation) return;
            for (let f of ctx.request.form?.elements ?? []) flight.get(f)?.abort();
        },

        ypy_after_request: (elt, {ctx}) => {
            let v = ctx.fieldValidation;
            if (!v) return;
            let ok = ctx.response.status < 400;
            // a batch: every place starts empty, the answer fills those of the invalid fields
            if (v.fields[1] && (ok || ctx.response.status === 422)) v.boxes.forEach(b => b.replaceChildren());
            // valid and nothing to say: leave nothing of an earlier message
            else if (ok && !ctx.text.trim()) {
                ctx.swap = 'none';
                v.box.replaceChildren();
            }
        },

        ypy_response_error: (elt, {ctx}) => {
            let v = ctx.fieldValidation;
            if (!v) return;
            if (ctx.response.status !== 422) {
                ctx.swap = 'none';
                return;
            }
            let a = name => api.attr(v.field, 'ypy-error-' + name), focus = a('focus');
            ctx.target = v.box;
            ctx.swap = v.fields[1] ? 'none' : a('swap') || 'innerHTML';
            ctx.focus = focus == null || focus === 'false' ? false : focus;
        },

        ypy_finally_request: (elt, {ctx}) => {
            let v = ctx.fieldValidation;
            if (!v) return;
            for (let f of v.fields) if (flight.get(f) === v.abort) flight.delete(f);
            if (ctx.status !== 'swapped') return;
            let status = ctx.response.status;
            v.fields.forEach((field, i) => {
                let box = v.boxes[i], ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
                // a batch names the invalid fields by what their places show
                if (status === 422 && (!v.fields[1] || box.hasChildNodes())) {
                    field.setAttribute('aria-invalid', 'true');
                    if (!ids.includes(box.id)) field.setAttribute('aria-describedby', [...ids, box.id].join(' '));
                } else if (status < 400 || status === 422) {
                    field.removeAttribute('aria-invalid');
                }
            });
        }
    });

})();
