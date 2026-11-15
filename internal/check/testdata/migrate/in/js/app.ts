export function load(el: HTMLElement): void {
  const h: Record<string, string> = { "ACME-Trigger": "x" };
  el.setAttribute("acme-target", "#out");
  window.bolt?.process(el);
}
