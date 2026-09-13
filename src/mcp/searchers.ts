import { ArxivSearcher } from '../platforms/ArxivSearcher.js';
import { WebOfScienceSearcher } from '../platforms/WebOfScienceSearcher.js';
import { PubMedSearcher } from '../platforms/PubMedSearcher.js';
import { BioRxivSearcher, MedRxivSearcher } from '../platforms/BioRxivSearcher.js';
import { SemanticScholarSearcher } from '../platforms/SemanticScholarSearcher.js';
import { IACRSearcher } from '../platforms/IACRSearcher.js';
import { GoogleScholarSearcher } from '../platforms/GoogleScholarSearcher.js';
import { SciHubSearcher } from '../platforms/SciHubSearcher.js';
import { ScienceDirectSearcher } from '../platforms/ScienceDirectSearcher.js';
import { SpringerSearcher } from '../platforms/SpringerSearcher.js';
import { WileySearcher } from '../platforms/WileySearcher.js';
import { ScopusSearcher } from '../platforms/ScopusSearcher.js';
import { CrossrefSearcher } from '../platforms/CrossrefSearcher.js';
import { PublicAccessDiscovery } from '../services/PublicAccessDiscovery.js';
import { RetrievalService } from '../retrieval/RetrievalService.js';
import { DirectHttpProvider } from '../retrieval/DirectHttpProvider.js';
import { ScrapingAntProvider } from '../retrieval/ScrapingAntProvider.js';
import { parseRetrievalConfiguration } from '../retrieval/Configuration.js';
import { logDebug } from '../utils/Logger.js';

export interface Searchers {
  arxiv: ArxivSearcher;
  webofscience: WebOfScienceSearcher;
  pubmed: PubMedSearcher;
  wos: WebOfScienceSearcher;
  biorxiv: BioRxivSearcher;
  medrxiv: MedRxivSearcher;
  semantic: SemanticScholarSearcher;
  iacr: IACRSearcher;
  googlescholar: GoogleScholarSearcher;
  scholar: GoogleScholarSearcher;
  scihub: SciHubSearcher;
  sciencedirect: ScienceDirectSearcher;
  springer: SpringerSearcher;
  wiley: WileySearcher;
  scopus: ScopusSearcher;
  crossref: CrossrefSearcher;
  publicAccess: PublicAccessDiscovery;
  /** Legacy status seam retained for injected test/adapter registries only. */
  scrapingAnt?: { getStatus(): Record<string, unknown> };
  /** Canonical business-platform registry; aliases and infrastructure stay outside it. */
  platforms: Record<string, any>;
  /** Operation factory owned by the MCP composition boundary. */
  retrievalService: RetrievalService;
}

let searchers: Searchers | null = null;

export function initializeSearchers(): Searchers {
  if (searchers) return searchers;

  logDebug('Initializing searchers...');

  const arxivSearcher = new ArxivSearcher();
  const retrievalConfiguration = parseRetrievalConfiguration();
  let retrievalService: RetrievalService | undefined;
  const googleScholarSearcher = new GoogleScholarSearcher(undefined, {
    retrievalServiceFactory: scholarHttpClient => {
      retrievalService = new RetrievalService({
        directProvider: new DirectHttpProvider({
          publicHttpClients: { scholar_search: scholarHttpClient }
        }),
        scrapingAntProvider: new ScrapingAntProvider({ apiKey: retrievalConfiguration.scrapingAnt.apiKey }),
        configuration: retrievalConfiguration
      });
      return retrievalService;
    }
  });
  if (!retrievalService) throw new Error('Failed to initialize the shared retrieval service');
  const publicAccessDiscovery = new PublicAccessDiscovery(undefined, {
    retrievalService,
    configuration: retrievalConfiguration
  });
  const wosSearcher = new WebOfScienceSearcher(undefined, undefined, {
    retrievalService,
    publicAccessDiscovery
  });
  const pubmedSearcher = new PubMedSearcher(process.env.PUBMED_API_KEY);
  const biorxivSearcher = new BioRxivSearcher('biorxiv');
  const medrxivSearcher = new MedRxivSearcher();
  const semanticSearcher = new SemanticScholarSearcher(process.env.SEMANTIC_SCHOLAR_API_KEY);
  const iacrSearcher = new IACRSearcher();
  const sciHubSearcher = new SciHubSearcher({ retrievalService });
  const scienceDirectSearcher = new ScienceDirectSearcher(process.env.ELSEVIER_API_KEY);
  const springerSearcher = new SpringerSearcher(
    process.env.SPRINGER_API_KEY,
    process.env.SPRINGER_OPENACCESS_API_KEY
  );
  const wileySearcher = new WileySearcher(process.env.WILEY_TDM_TOKEN);
  const scopusSearcher = new ScopusSearcher(
    process.env.ELSEVIER_API_KEY,
    process.env.SCOPUS_SEARCH_API_KEY
  );
  const crossrefSearcher = new CrossrefSearcher(process.env.CROSSREF_MAILTO);

  searchers = {
    arxiv: arxivSearcher,
    webofscience: wosSearcher,
    pubmed: pubmedSearcher,
    wos: wosSearcher,
    biorxiv: biorxivSearcher,
    medrxiv: medrxivSearcher,
    semantic: semanticSearcher,
    iacr: iacrSearcher,
    googlescholar: googleScholarSearcher,
    scholar: googleScholarSearcher,
    scihub: sciHubSearcher,
    sciencedirect: scienceDirectSearcher,
    springer: springerSearcher,
    wiley: wileySearcher,
    scopus: scopusSearcher,
    crossref: crossrefSearcher,
    publicAccess: wosSearcher.getPublicAccessDiscovery(),
    platforms: {
      arxiv: arxivSearcher,
      webofscience: wosSearcher,
      pubmed: pubmedSearcher,
      biorxiv: biorxivSearcher,
      medrxiv: medrxivSearcher,
      semantic: semanticSearcher,
      iacr: iacrSearcher,
      googlescholar: googleScholarSearcher,
      scihub: sciHubSearcher,
      sciencedirect: scienceDirectSearcher,
      springer: springerSearcher,
      wiley: wileySearcher,
      scopus: scopusSearcher,
      crossref: crossrefSearcher
    },
    retrievalService
  };

  logDebug('Searchers initialized successfully');
  return searchers;
}
