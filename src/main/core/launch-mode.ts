export function shouldOpenDesktop(argv: string[]): boolean {
  return !argv.includes("--host") && !argv.includes("--summarize-all");
}
