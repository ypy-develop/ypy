// SPDX-License-Identifier: MIT
//==========================================================
// ypy-switch.js
//
// Shows or hides a part of a form according to the value of a field, with no request.
//
// ypy-switch on the part says when it is shown:
//
//   ypy-switch="kind=company"          the field `kind` has the value company
//   ypy-switch="kind=company|ngo"      ... one of these values
//   ypy-switch="kind!=person"          ... is not one of these values
//   ypy-switch="newsletter"            the field has a value (a checkbox or radio: it is checked)
//
// The field is found by name, inside the form that holds the part (in the whole page when the
// part is in no form). A radio group or a set of checkboxes with the same name counts as one
// field; a select with several options chosen has several values and any of them can match. A
// checkbox with no value attribute has the value "on".
//
// A part that is not shown gets the hidden attribute, and the fields inside it are disabled: they
// are not submitted and a required one does not stop the submit. When the part is shown again the
// fields that the extension disabled come back (one that the page had disabled stays disabled). If
// your CSS gives the part a display value, add `[hidden] { display: none }` for it.
//
// It follows the input and change events of the form, a reset, and content that arrives in a swap.
// A script that sets a value without an event calls ypy.switch.update(). A part fires
// ypy:switch ({shown}) when it changes; its first evaluation is silent. Nested parts are
// evaluated in document order, so an outer part that is hidden keeps the inner ones disabled.
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// Usage:
//   <script src="ypy-switch.js"></script>
//   <form>
//     <select name="kind"><option value="person">Person<option value="company">Company</select>
//     <div ypy-switch="kind=company"><input name="cnpj" required></div>
//   </form>
//==========================================================
(() => {

    let api;
    const state = new WeakMap();   // part -> shown last time
    const off = new WeakSet();     // fields this extension disabled
    const CONTROLS = 'input,select,textarea,button,fieldset';
    const parts = () => api.prefixSelector('[ypy-switch]');

    // The values of the fields named `name` in the scope, as a list of strings.
    function values(scope, name) {
        let out = [];
        for (let f of scope.querySelectorAll(`[name="${CSS.escape(name)}"]`)) {
            if (f.type === 'checkbox' || f.type === 'radio') {
                if (f.checked) out.push(f.value);
            } else if (f.tagName === 'SELECT') {
                out.push(...[...f.selectedOptions].map(o => o.value));
            } else {
                out.push(f.value);
            }
        }
        return out;
    }

    // Does the rule `name`, `name=a|b` or `name!=a|b` hold for the part?
    function holds(part, rule) {
        let [, name, not, list] = /^\s*([^=!\s]+)\s*(!?)(?:=\s*(.*?))?\s*$/.exec(rule) || [];
        if (!name) return true;
        let have = values(part.closest('form') || document, name);
        if (list == null) return have.some(v => v !== '');
        let wanted = list.split('|').map(v => v.trim());
        return have.some(v => wanted.includes(v)) !== !!not;
    }

    function show(part, shown) {
        let first = !state.has(part), was = state.get(part);
        state.set(part, shown);
        part.hidden = !shown;
        // inside a part that is hidden, the fields stay disabled whatever this part says
        let up = part.parentElement?.closest(parts());
        while (up && !up.hidden) up = up.parentElement?.closest(parts());
        for (let f of part.matches(CONTROLS) ? [part] : part.querySelectorAll(CONTROLS)) {
            if ((!shown || up) && !f.disabled) { f.disabled = true; off.add(f) }
            else if (shown && !up && off.delete(f)) f.disabled = false;
        }
        if (!first && was !== shown) api.triggerEvent(part, 'ypy:switch', {shown});
    }

    // Evaluates the parts of a subtree, outer ones first.
    function update(root = document) {
        for (let part of [...root.matches?.(parts()) ? [root] : [], ...root.querySelectorAll?.(parts()) ?? []]) {
            show(part, holds(part, api.attr(part, 'ypy-switch') || ''));
        }
    }

    // The parts that depend on the form of a field
    const refresh = field => update(field.form || document);

    document.addEventListener('input', evt => refresh(evt.target));
    document.addEventListener('change', evt => refresh(evt.target));
    document.addEventListener('reset', evt => setTimeout(update, 0, evt.target));

    ypy.registerExtension('ypy-switch', {

        init: (internalApi) => {
            api = internalApi;
            ypy.switch = {
                /** Evaluates the parts again: call it after a script set a value without an event. */
                update
            };
        },

        // new content: its own parts, and the parts of the form it joined
        ypy_after_process: (elt) => { update(elt.closest?.('form') || elt) }
    });

})();
