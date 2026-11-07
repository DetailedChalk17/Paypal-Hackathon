export async function analyzeEvidence(_filePath: string) {
  // Mock AI response for hackathon development
  return {
    status: "completed",
    summary: "Mock AI analysis completed",
    findings: [],
  };
}

export async function analyzeWithTimeout(filePath: string) {
  let timeout: ReturnType<typeof setTimeout>;

  try {
    return await Promise.race([
      analyzeEvidence(filePath),

      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("AI analysis timed out")),
          5000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout!);
  }
}