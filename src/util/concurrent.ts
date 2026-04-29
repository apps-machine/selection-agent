export interface MapWithConcurrencyResult<T> {
  results: Array<{ ok: true; value: T } | { ok: false; error: Error }>;
  successes: T[];
  failures: Error[];
}

export async function mapWithConcurrency<I, O>(
  inputs: readonly I[],
  concurrency: number,
  fn: (input: I, index: number) => Promise<O>,
): Promise<MapWithConcurrencyResult<O>> {
  if (concurrency < 1) throw new Error("concurrency must be >= 1");
  const results: MapWithConcurrencyResult<O>["results"] = new Array(inputs.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= inputs.length) return;
      const input = inputs[i]!;
      try {
        const value = await fn(input, i);
        results[i] = { ok: true, value };
      } catch (e) {
        results[i] = {
          ok: false,
          error: e instanceof Error ? e : new Error(String(e)),
        };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    worker,
  );
  await Promise.all(workers);

  const successes: O[] = [];
  const failures: Error[] = [];
  for (const r of results) {
    if (!r) continue;
    if (r.ok) successes.push(r.value);
    else failures.push(r.error);
  }
  return { results, successes, failures };
}
