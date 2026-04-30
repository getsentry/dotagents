/** Whether a skill source points to its own install location (adopted orphan). */
export function isInPlaceSkill(source: string): boolean {
  return source.startsWith("path:.agents/skills/") || source.startsWith("path:skills/");
}
