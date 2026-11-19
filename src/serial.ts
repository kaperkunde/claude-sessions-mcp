/**
 * One at a time: everything that may use or replace the claude.ai login's
 * refresh token runs through one Serial (a renewal here, the CLI's sign-in
 * finishing, the CLI starting a session), so the refresh token, which
 * rotates on every use, is never sent twice. A failure does not block the
 * next one in line.
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => undefined)
    return result
  }
}
