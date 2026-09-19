import type { AxiosRequestConfig } from 'axios';
import { DirectHttpProvider } from './DirectHttpProvider.js';
import { RetrievalService, type RetrievalServiceOptions } from './RetrievalService.js';
import { ScrapingAntProvider } from './ScrapingAntProvider.js';
import { parseRetrievalConfiguration, type RetrievalConfiguration } from './Configuration.js';
import type { OutboundPurpose } from './OutboundSecurityPolicy.js';
import type { RetrievalProvider, RetrievalTransportProfile } from './types.js';
import type { PublicHttpResponse } from '../services/PublicHttpClient.js';

export type RetrievalDirectClient = {
  request(url: string, config?: AxiosRequestConfig): Promise<PublicHttpResponse<unknown>>;
};

export interface CreateRetrievalServiceOptions {
  directProvider?: RetrievalProvider;
  directClient?: RetrievalDirectClient;
  directClients?: Partial<Record<OutboundPurpose, RetrievalDirectClient>>;
  directClientsByProfile?: Partial<Record<RetrievalTransportProfile, RetrievalDirectClient>>;
  scrapingAntProvider?: RetrievalProvider;
  securityPolicy?: RetrievalServiceOptions['securityPolicy'];
  configuration?: RetrievalConfiguration;
}

/**
 * Composition-only factory. Concrete provider construction stays at the
 * retrieval boundary rather than leaking into platform adapters.
 */
export function createRetrievalService(options: CreateRetrievalServiceOptions = {}): RetrievalService {
  const configuration = options.configuration || parseRetrievalConfiguration();
  return new RetrievalService({
    directProvider: options.directProvider || new DirectHttpProvider({
      publicHttpClient: options.directClient,
      publicHttpClients: options.directClients,
      publicHttpClientsByProfile: options.directClientsByProfile
    }),
    scrapingAntProvider: options.scrapingAntProvider || new ScrapingAntProvider(),
    securityPolicy: options.securityPolicy,
    configuration
  });
}

export default createRetrievalService;
