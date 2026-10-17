/** True only while an async search result still belongs to the current query. */
export function canApplySearchGeneration(
  requestGeneration: number,
  currentGeneration: number,
  cancelled: boolean,
): boolean {
  return !cancelled && requestGeneration === currentGeneration;
}
