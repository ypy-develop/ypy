// SPDX-License-Identifier: MIT
//
// The attribute inheritance rules, in one list. The matrix test
// (test/tests/attributes/inheritance-native.js) checks the core against it. renderTable() renders
// the table of the inheritance reference page of the website (https://ypy.dev/docs/reference/inheritance)
// from it; the page is kept in the website repository, not here.
//
// Every attribute is written as ypy-<name>; the resolver reads ypy-<name> and data-ypy-<name>.

/**
 * @typedef {object} InheritanceRule
 * @property {string} attr         the attribute, ypy-<name>
 * @property {string} group        the heading of the row in the table
 * @property {boolean} inherits    true: `:inherited` and `:append` work; false: the element's own value only
 * @property {string} [note]
 */

const ordinary = (group, attrs) => attrs.map(attr => ({attr, group, inherits: true}));

/** @type {InheritanceRule[]} */
export const RULES = [
  ...ordinary('Request', ['ypy-target', 'ypy-swap', 'ypy-select', 'ypy-select-oob', 'ypy-push-url', 'ypy-replace-url',
    'ypy-confirm', 'ypy-config', 'ypy-encoding', 'ypy-sync', 'ypy-method', 'ypy-include', 'ypy-vals', 'ypy-headers',
    'ypy-indicator', 'ypy-disable', 'ypy-boost', 'ypy-status:404']),
  ...ordinary('What starts a request', ['ypy-action', 'ypy-get', 'ypy-post', 'ypy-put', 'ypy-patch', 'ypy-delete',
    'ypy-trigger', 'ypy-validate']),
  // Phase 1 attributes: read through __attributeValue, so the general rule applies
  ...ordinary('Phase 1', ['ypy-error-target', 'ypy-error-swap', 'ypy-error-focus', 'ypy-focus', 'ypy-scroll',
    'ypy-announce', 'ypy-retry', 'ypy-busy']),
  // read from the element itself, never through __attributeValue
  ...['ypy-swap-oob', 'ypy-preserve', 'ypy-preserve-attrs', 'ypy-on', 'ypy-history-elt'].map(attr =>
    ({attr, group: 'Element only', inherits: false})),
];

const yes = v => v ? 'yes' : 'no';

/** The rows of the table of the inheritance reference page, between its two marker comments. */
export function renderTable(rules = RULES) {
  let rows = ['| Attribute | Group | `:inherited` and `:append` |',
              '|---|---|---|'];
  for (let r of rules) {
    rows.push(`| \`${r.attr}\` | ${r.group} | ${yes(r.inherits)} |`);
  }
  return rows.join('\n');
}
