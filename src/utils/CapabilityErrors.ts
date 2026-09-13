export class CapabilityUnavailableError extends Error {
  public readonly platform: string;
  public readonly capability: string;

  constructor(platform: string, capability: string, message?: string) {
    super(message || `${platform} capability is unavailable: ${capability}`);
    this.name = 'CapabilityUnavailableError';
    this.platform = platform;
    this.capability = capability;
  }
}

export default CapabilityUnavailableError;
