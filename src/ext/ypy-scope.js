// SPDX-License-Identifier: MIT
//==========================================================
// ypy-scope.js
//
// Targets the core does not know, for every attribute that takes a selector (ypy-target,
// ypy-indicator, ypy-include, ypy-disable, ypy-sync, `from:` of a trigger, ypy.find()):
//
//   scope             the closest ancestor with the ypy-scope attribute (the element itself counts);
//                     the search goes on from the host when the element sits in a shadow root
//   scope <selector>  the elements that match the selector inside that scope
//   layer             the element of the topmost open layer of the ypy-layers extension
//                     (nothing when no layer is open or ypy-layers is not loaded)
//   layer <selector>  the elements that match the selector inside that layer
//   shadow:<selector> the elements that match the selector below the element, in the flat tree:
//                     the light DOM, the nested open shadow roots (closed ones cannot be entered),
//                     and inside a shadow root the content a <slot> shows (assignedElements,
//                     flattened, with the slot's own content when nothing is assigned), so a light
//                     child that no slot shows is not found. The element itself is not matched.
//
// Usage:
//   <section ypy-scope>
//     <button ypy-get="/save" ypy-target="scope">Save</button>
//     <button ypy-get="/hint" ypy-target="scope .hint">Hint</button>
//   </section>
//   <button ypy-get="/state" ypy-target="shadow:.badge">Refresh the badges</button>
//
// The extension answers the ypy_resolve_target hook of the core, which asks before the selector
// falls to querySelectorAll. Anything else is left to the core (the hook returns undefined).
//==========================================================
(() => {
    let api;

    // the elements below `node` as a browser renders them: a host shows its shadow root, a slot what is assigned to it
    function* flat(node) {
        let kids = node.localName == 'slot' ? node.assignedElements({flatten: true}) : node.shadowRoot?.children ?? node.children;
        for (let kid of kids ?? []) {
            yield kid;
            yield* flat(kid);
        }
    }

    // the closest scope of an element; from a shadow root it goes on from the host
    function scopeOf(elt) {
        let selector = api.prefixSelector('[ypy-scope]');
        for (let at = elt; at; at = at.getRootNode?.().host) {
            let scope = at.closest?.(selector);
            if (scope) return scope;
        }
        return null;
    }

    ypy.registerExtension('ypy-scope', {
        init(internalAPI) {
            api = internalAPI;
        },
        ypy_resolve_target(elt, selector) {
            let [, kind, rest] = selector.match(/^(scope|layer)(?:\s+([\s\S]+))?$/) ?? selector.match(/^(shadow):\s*([\s\S]+)$/) ?? [];
            if (!kind) return;
            if (kind == 'shadow') return [...flat(elt)].filter(found => found.matches(rest));
            let root = kind == 'scope' ? scopeOf(elt) : ypy.layers?.top()?.element;
            return !root || !rest ? root ?? null : [...root.querySelectorAll(rest)];
        }
    });
})();
