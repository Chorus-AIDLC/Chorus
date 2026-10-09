export function deliveryError(error) {
  const name = error?.name === "TimeoutError" ? "TimeoutError" : error?.name === "AbortError" ? "AbortError" : "fetch failed";
  const code = error?.cause?.code ?? error?.code ?? error?.message;
  if (error?.name === "Error" && error?.message === code && typeof code === "string" && /^[A-Z][A-Z0-9_]{0,50}$/.test(code)) return `Error: ${code}`;
  return `${name}${typeof code === "string" && /^[A-Z][A-Z0-9_]{0,50}$/.test(code) ? ` (${code})` : ""}`;
}

export async function deliveryRequest(operation, { signal, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  let timer;
  let abort;
  const cancelled = new Promise((resolve, reject) => {
    abort = () => {
      const error = new Error("Delivery cancelled");
      error.name = "AbortError";
      controller.abort(error);
      reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      const error = new Error("Delivery deadline exceeded");
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) abort();
  });
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
