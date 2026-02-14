/**
 * Thrown when an agent does not support a requested feature (e.g. hooks).
 */
export class UnsupportedFeature extends Error {
  constructor(
    public readonly agentId: string,
    public readonly feature: string,
  ) {
    super(`Agent "${agentId}" does not support ${feature}`);
    this.name = "UnsupportedFeature";
  }
}
