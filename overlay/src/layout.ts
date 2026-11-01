export function stageScale(viewportWidth: number, viewportHeight: number): number {
  if (viewportWidth <= 0 || viewportHeight <= 0) return 0;
  return Math.min(viewportWidth / 1920, viewportHeight / 1080);
}
