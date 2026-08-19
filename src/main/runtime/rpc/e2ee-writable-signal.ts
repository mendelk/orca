export class E2EEWritableSignal {
  private handler: (() => void) | null = null

  on(handler: () => void): void {
    this.handler = handler
  }

  notify(): void {
    this.handler?.()
  }

  clear(): void {
    this.handler = null
  }
}
