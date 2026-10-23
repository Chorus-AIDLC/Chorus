export async function withTransactionRetry<Result>(
  work: () => Promise<Result>,
  maxRetries = 3,
): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt < maxRetries && typeof error === "object" && error !== null && "code" in error && error.code === "P2034") continue;
      throw error;
    }
  }
}
