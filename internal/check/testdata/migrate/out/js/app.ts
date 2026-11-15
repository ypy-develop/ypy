export function load(el: HTMLElement): void {
  const h: Record<string, string> = { "YPY-Trigger": "x" };
  el.setAttribute("ypy-target", "#out");
  window.ypy?.process(el);
}
