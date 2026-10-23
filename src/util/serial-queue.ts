/** Process-local ordering only; does not provide a cross-process transaction. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(work);
    this.tail = result;
    return result;
  }
  async drain(): Promise<void> { await this.tail.catch(() => undefined); }
}
