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
}

let searchers: Searchers | null = null;

export function initializeSearchers(): Searchers {
  if (searchers) return searchers;

  logDebug('Initializing searchers...');

  const arxivSearcher = new ArxivSearcher();
  const wosSearcher = new WebOfScienceSearcher(process.env.WOS_API_KEY, process.env.WOS_API_VERSION);
  const pubmedSearcher = new PubMedSearcher(process.env.PUBMED_API_KEY);
  const biorxivSearcher = new BioRxivSearcher('biorxiv');
  const medrxivSearcher = new MedRxivSearcher();
  const semanticSearcher = new SemanticScholarSearcher(process.env.SEMANTIC_SCHOLAR_API_KEY);
  const iacrSearcher = new IACRSearcher();
  const googleScholarSearcher = new GoogleScholarSearcher();
  const sciHubSearcher = new SciHubSearcher();
  const scienceDirectSearcher = new ScienceDirectSearcher(process.env.ELSEVIER_API_KEY);
  const springerSearcher = new SpringerSearcher(
    process.env.SPRINGER_API_KEY,
    process.env.SPRINGER_OPENACCESS_API_KEY
  );
  const wileySearcher = new WileySearcher(process.env.WILEY_TDM_TOKEN);
  const scopusSearcher = new ScopusSearcher(process.env.ELSEVIER_API_KEY);
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
    crossref: crossrefSearcher
  };

  logDebug('Searchers initialized successfully');
  return searchers;
}
