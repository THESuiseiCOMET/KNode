// Prevent the WebView page menu without stopping application menu handlers.
// Text fields retain the native cut/copy/paste menu.
export function isTextMenuTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      'input:not([type="range"]):not([type="color"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]),textarea,[contenteditable="true"]',
    )
  )
}
export function suppressBrowserMenu(event: MouseEvent): void {
  if (!isTextMenuTarget(event.target)) event.preventDefault()
}
