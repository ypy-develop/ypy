// SPDX-License-Identifier: MIT
// Type-level test of src/ypy.d.ts: this file must compile as it is, and each line that follows an
// expect-error comment must fail to compile. internal/gen/tsc_test.go runs tsc over it when tsc is installed.
import ypy, { YpyConfig, YpyEvent, YpyEventMap, YpyHookMap, YpyRequestCtx } from '../../../../src/ypy';

// An event listener sees the detail of its event.
ypy.on('ypy:before:request', (evt) => {
  const ctx: YpyRequestCtx = evt.detail.ctx;
  ctx.request.headers['X-Test'] = '1';
  evt.preventDefault();
});
ypy.on('#list', 'ypy:after:swap', (evt) => evt.detail.ctx.target);
ypy.on('ypy:sse:close', (evt) => {
  const reason: 'cancelled' | 'message' | 'ended' | 'removed' | 'cleanup' = evt.detail.reason;
  return reason;
});
// @ts-expect-error a field the event does not have
ypy.on('ypy:sse:close', (evt) => evt.detail.nope);

// The same through the DOM, with the global event maps.
document.addEventListener('ypy:response:error', (evt) => evt.detail.ctx.response?.status);
document.body.addEventListener('ypy:request:retry', (evt) => evt.detail.attempt + evt.detail.delay);
const typed: YpyEvent<'ypy:confirm'> = new CustomEvent('ypy:confirm', {
  detail: { ctx: {} as YpyRequestCtx, issueRequest() {}, dropRequest() {} },
});
typed.detail.dropRequest();

// Every key of the event map is a name that starts with ypy:.
const names: (keyof YpyEventMap)[] = ['ypy:abort', 'ypy:ws:close', 'ypy:history:cache:hit'];
names.forEach((n) => n.startsWith('ypy:'));

// Hooks are not DOM events.
const hook: YpyHookMap['ypy:scope'] = { scope: {}, code: '' };
hook.code += '';
// @ts-expect-error a hook is not in the event map
const notAnEvent: keyof YpyEventMap = 'ypy:scope';

// The configuration, with the keys of the extensions.
const cfg: Partial<YpyConfig> = {
  defaultSwap: 'innerHTML',
  history: 'reload',
  classes: { request: 'busy', swapping: 'a', settling: 'b', added: 'c', indicator: 'd', dirty: 'dirty' },
  announce: { clearAfter: 3000, messages: { done: 'Saved' } },
  retry: { attempts: 3, methods: ['GET'] },
  live: { inputDebounce: 50 },
  sse: { reconnect: true, releaseOn: 'first' },
  ws: { protocols: ['v1'] },
  historyCache: { size: 5 },
  preload: { autoBoost: false },
};
// @ts-expect-error not a config key
cfg.noSuchKey = true;
// @ts-expect-error history takes true, false or "reload"
cfg.history = 'sometimes';

// The API of the ypy object.
ypy.config.logAll = true;
ypy.config.lock?.();
ypy.signals?.patch({ count: 1 });
ypy.ajax('GET', '/items', { target: '#list', swap: 'outerHTML', timeout: '5s' }).then(() => {});
ypy.trigger('#x', 'ypy:abort', {});
ypy.onLoad('[data-tip]', (el) => el.classList.add('x'));
ypy.registerExtension('demo', {});
