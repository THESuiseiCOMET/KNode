/** Display only. The authoritative directory comes from Rust's opened session. */
export function pathParts(path: string): { start: string; middle: string; name: string } {
  const normalized = path.replace(/\/$/, '')
  const separator = normalized.includes('\\') ? '\\' : '/'
  const parts = normalized.split(separator)
  if (parts.length <= 2) return { start: '', middle: '', name: path }
  const name = parts.pop()!
  const start = path.startsWith('\\\\')
    ? `${parts.splice(0, 4).join(separator)}${separator}`
    : `${parts.shift()}${separator}`
  return { start, middle: parts.length ? `${parts.join(separator)}${separator}` : '', name }
}

/** Hide Win32 extended-length prefixes in labels only; never change I/O paths. */
export function displayProjectPath(path: string): string {
  const backslash = String.fromCharCode(92)
  if (!path.startsWith(backslash + backslash + '?' + backslash)) return path
  const rest = path.slice(4)
  return rest.slice(0, 4).toUpperCase() === 'UNC' + backslash
    ? backslash + backslash + rest.slice(4)
    : rest
}
