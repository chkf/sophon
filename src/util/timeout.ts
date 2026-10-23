/** Bounds waiting only; the caller owns cancellation of underlying work. */
export async function withTimeout<T>(work: Promise<T>, ms: number, label = "Operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
