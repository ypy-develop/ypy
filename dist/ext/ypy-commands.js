// SPDX-License-Identifier: MIT
//==========================================================
// ypy-commands.js
//
// Client commands from the server, in a response header, with no eval.
//
//   YPY-Commands: [{"type":"addClass","target":"#row-4","class":"saved"},
//                  {"type":"focus","target":"#name"}]
//
// The value is a JSON list. Each command is an object with a "type" and a "target", a CSS
// selector: the command acts on every element the selector matches, in document order. The
// commands run in the order of the list, after the response was swapped (in the
// ypy:finally:request of the request), so a target can be an element the response brought. A
// response that is not swapped (204, an error) runs them too. Non-ASCII text has to be written as
// \uXXXX in a header.
//
//   addClass, removeClass       {"class": "a b"}
//   toggleClass                 {"class": "a b", "force": true}   (force is optional)
//   setAttribute                {"name": "title", "value": "Saved"}
//   removeAttribute             {"name": "title"}
//   focus                       {}
//   scrollIntoView              {"behavior": "smooth", "block": "center", "inline": "nearest"}
//   remove                      {}
//   dispatch                    {"event": "saved", "detail": {...}, "bubbles": true}
//                               (the target is optional here: without it the event goes to document)
//   show, hide                  {}   (they remove and set the hidden attribute: a rule of the
//                                    page that forces a display wins over it)
//
// A command that is not in the list, or whose fields are not what the table says, or whose
// selector is not valid, is not run: a console warning and ypy:commands:ignored on the source
// element say why, and the next command runs. A command that targets nothing is skipped without
// a warning (the element may be gone). setAttribute cannot write an event handler (on*), style,
// srcdoc or an attribute of YPY itself, nor a javascript: URL: that would be code, and the
// header must not be a way around the page's CSP. A list that is not valid JSON, or is longer
// than config.commands.max (100), is ignored as a whole.
//
// Cancel ypy:before:command (it fires on the source element with {ctx, command, targets}) to skip
// one command. ypy.commands.run(list, source) runs a list the same way, for code that gets its
// commands elsewhere.
//==========================================================
(() => {

    let api;

    const str = v => typeof v == 'string' && v !== '';
    const tokens = v => str(v) ? v.trim().split(/\s+/) : null;
    // JavaScript hidden in an attribute value: whitespace and control characters are ignored by URL parsers
    const script = v => /^[\x00-\x20]*(javascript|vbscript|data:text\/html)/i.test(String(v).replace(/[\t\n\r]/g, ''));
    const isYpyName = n => /^(data-)?ypy-/i.test(n) || (ypy.config.prefix && n.toLowerCase().startsWith(ypy.config.prefix.toLowerCase()));

    // takes an element out the way the core does for what it removes: its timers and listeners go with it
    function drop(el) {
        for (let e of [el, ...el.querySelectorAll('[data-ypy-powered]')]) {
            if (!e._ypy) continue;
            api.triggerEvent(e, 'ypy:before:cleanup', {}, false);
            for (let s of e._ypy.triggerSpecs ?? []) {
                clearInterval(s.interval);
                clearTimeout(s.timeout);
                s.observer?.disconnect();
            }
            for (let i of e._ypy.listeners ?? []) i.fromElt.removeEventListener(i.eventName, i.handler, i);
        }
        el.remove();
    }

    // the checks of the fields each command needs; they return the reason or nothing
    const commands = {
        addClass: {check: c => tokens(c.class) ? 0 : 'class', run: (e, c) => e.classList.add(...tokens(c.class))},
        removeClass: {check: c => tokens(c.class) ? 0 : 'class', run: (e, c) => e.classList.remove(...tokens(c.class))},
        toggleClass: {
            check: c => tokens(c.class) ? c.force != null && typeof c.force != 'boolean' ? 'force' : 0 : 'class',
            run: (e, c) => tokens(c.class).forEach(t => c.force == null ? e.classList.toggle(t) : e.classList.toggle(t, c.force))
        },
        setAttribute: {
            check: c => !str(c.name) || /[\s"'<>\/=\x00]/.test(c.name) ? 'name' :
                c.value != null && typeof c.value == 'object' ? 'value' :
                /^(on|style$|srcdoc$)/i.test(c.name) || isYpyName(c.name) || script(c.value ?? '') ? 'blocked' : 0,
            run: (e, c) => e.setAttribute(c.name, String(c.value ?? ''))
        },
        removeAttribute: {check: c => str(c.name) ? 0 : 'name', run: (e, c) => e.removeAttribute(c.name)},
        focus: {check: () => 0, run: e => e.focus()},
        scrollIntoView: {
            check: c => ['behavior', 'block', 'inline'].some(k => c[k] != null && typeof c[k] != 'string') ? 'options' : 0,
            run: (e, c) => e.scrollIntoView({behavior: c.behavior ?? 'auto', block: c.block ?? 'start', inline: c.inline ?? 'nearest'})
        },
        remove: {check: () => 0, run: drop},
        dispatch: {
            check: c => str(c.event) ? 0 : 'event',
            run: (e, c) => e.dispatchEvent(new CustomEvent(c.event, {detail: c.detail, bubbles: c.bubbles !== false, cancelable: true}))
        },
        show: {check: () => 0, run: e => e.removeAttribute('hidden')},
        hide: {check: () => 0, run: e => e.setAttribute('hidden', '')}
    };

    function ignore(source, command, reason) {
        console.warn(`ypy-commands: ignored ${JSON.stringify(command)?.slice(0, 120)}: ${reason}`);
        api.triggerEvent(source, 'ypy:commands:ignored', {command, reason});
    }

    function run(list, source, ctx) {
        source = source?.isConnected ? source : document.body;
        let max = ypy.config.commands?.max ?? 100;
        if (typeof list == 'string') {
            try { list = JSON.parse(list) } catch { return ignore(source, list, 'not valid JSON') }
        }
        if (!Array.isArray(list)) return ignore(source, list, 'not a list');
        if (list.length > max) return ignore(source, `${list.length} commands`, `more than ${max}`);
        for (let command of list) {
            let known = command && typeof command == 'object' && Object.hasOwn(commands, command.type), spec = commands[command?.type];
            let reason = known ? spec.check(command) : 0;
            if (!known || reason) { ignore(source, command, !known ? 'unknown command' : reason == 'blocked' ? 'not allowed' : 'invalid ' + reason); continue }
            let targets;
            if (command.target == null && command.type == 'dispatch') {
                targets = [document];
            } else if (!str(command.target)) {
                ignore(source, command, 'invalid target'); continue;
            } else {
                try { targets = [...document.querySelectorAll(command.target)] } catch { ignore(source, command, 'invalid target'); continue }
            }
            if (targets.length && api.triggerEvent(source, 'ypy:before:command', {ctx, command, targets}))
                for (let elt of targets) spec.run(elt, command);
        }
    }

    ypy.registerExtension('ypy-commands', {
        init: a => {
            api = a;
            (ypy.commands ??= {}).run = (list, source) => run(list, source);
        },

        ypy_finally_request: (elt, {ctx}) => {
            let header = ctx.ypy?.commands;
            if (header && !ctx.commandsRun) { ctx.commandsRun = true; run(header, elt, ctx) }
        }
    });

})();
