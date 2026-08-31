/** A project input or filesystem problem that prevents a trustworthy analysis. */
export class AnalyzeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzeError';
  }
}
