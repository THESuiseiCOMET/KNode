/** Let canvas zoom through unless this content area can actually scroll. */
export function contentWheel(event: WheelEvent): void {
  const area = event.currentTarget as HTMLElement
  if (area.scrollHeight > area.clientHeight || area.scrollWidth > area.clientWidth)
    event.stopPropagation()
}
