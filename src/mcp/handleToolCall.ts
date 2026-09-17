import type { Searchers } from './searchers.js';
import type { ToolName } from './schemas.js';
import { parseToolArgs } from './schemas.js';
import { PaperFactory, type Paper } from '../models/Paper.js';
import { PaperSource, type SearchOptions } from '../platforms/PaperSource.js';
import { CitationService } from '../services/CitationService.js';
import { sanitizeBody, sanitizeDownloadPath, sanitizeDoi, sanitizeSensitiveText } from '../utils/SecurityUtils.js';
import { logDebug } from '../utils/Logger.js';
import type { RetrievalOperationContext, RetrievalPurpose } from '../retrieval/types.js';

const citationService = new CitationService();

function jsonTextResponse(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: sanitizeMcpText(text)
      }
    ]
  };
}

/** Sanitize structured payloads before JSON serialization so escaping stays valid. */
function sanitizeMcpText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(sanitizeBody(parsed), null, 2);
  } catch {
    // Most tool responses have a human-readable prefix followed by JSON, and
    // Sci-Hub may append a download message after that JSON. Sanitize the
    // balanced JSON segment as a value, not as serialized text.
  }

  const separator = text.indexOf('\n\n');
  const searchFrom = separator >= 0 ? separator + 2 : 0;
  const start = findJsonStart(text, searchFrom);
  if (start >= 0) {
    const end = findJsonEnd(text, start);
    if (end !== undefined) {
      try {
        const parsed = JSON.parse(text.slice(start, end));
        return `${sanitizeSensitiveText(text.slice(0, start))}${JSON.stringify(sanitizeBody(parsed), null, 2)}${sanitizeSensitiveText(text.slice(end))}`;
      } catch {
        // Fall through to plain-text redaction for non-JSON text.
      }
    }
  }
  return sanitizeSensitiveText(text);
}

function findJsonStart(text: string, from: number): number {
  const objectStart = text.indexOf('{', from);
  const arrayStart = text.indexOf('[', from);
  if (objectStart < 0) return arrayStart;
  if (arrayStart < 0) return objectStart;
  return Math.min(objectStart, arrayStart);
}

function getBusinessPlatformEntries(searchers: Searchers): Array<[string, any]> {
  if (searchers.platforms) return Object.entries(searchers.platforms);
  const infrastructure = new Set(['wos', 'scholar', 'scrapingAnt', 'publicAccess', 'retrievalService', 'platforms']);
  return Object.entries(searchers).filter(([name]) => !infrastructure.has(name));
}

function findJsonEnd(text: string, start: number): number | undefined {
  const expectedClosers: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      expectedClosers.push('}');
    } else if (character === '[') {
      expectedClosers.push(']');
    } else if (character === '}' || character === ']') {
      if (expectedClosers.pop() !== character) return undefined;
      if (expectedClosers.length === 0) return index + 1;
    }
  }
  return undefined;
}

export async function handleToolCall(
  toolNameRaw: string,
  rawArgs: unknown,
  searchers: Searchers,
  operationContext?: RetrievalOperationContext
) {
  const toolName = toolNameRaw as ToolName;
  // Validate and normalize business arguments before creating an operation.
  // Invalid input must not even allocate a retrieval budget or deadline.
  const args = parseToolArgs(toolName, rawArgs);
  const ownedOperation = operationContext ? undefined : searchers.retrievalService?.createOperation({
    purpose: retrievalPurposeForToolCall(toolName, args)
  });
  const operation = operationContext || ownedOperation;
  try {
    return await handleToolCallWithContext(toolName, args, searchers, operation);
  } finally {
    ownedOperation?.dispose?.();
  }
}

export function retrievalPurposeForToolCall(toolName: ToolName, args: any): RetrievalPurpose | undefined {
  switch (toolName) {
    case 'search_google_scholar':
      return 'scholar_search';
    case 'discover_paper_access':
      return 'publisher_discovery';
    case 'search_webofscience':
      return args?.discoverAccess === true ? 'publisher_discovery' : undefined;
    case 'search_papers':
      if (args?.platform === 'googlescholar' || args?.platform === 'scholar') return 'scholar_search';
      if (args?.platform === 'scihub') return 'scihub_lookup';
      return undefined;
    case 'search_scihub':
    case 'download_paper':
      return args?.platform === undefined || args?.platform === 'scihub' ? 'scihub_lookup' : undefined;
    case 'get_paper_by_doi':
      return args?.platform === 'scihub' ? 'scihub_lookup' : undefined;
    default:
      return undefined;
  }
}

async function handleToolCallWithContext(
  toolNameRaw: string,
  args: any,
  searchers: Searchers,
  operation?: RetrievalOperationContext
) {
  const toolName = toolNameRaw as ToolName;

  switch (toolName) {
    case 'search_papers': {
      const {
        query,
        platform,
        maxResults,
        year,
        author,
        journal,
        category,
        days,
        fetchDetails,
        fieldsOfStudy,
        sortBy,
        sortOrder
      } = args;

      const results: Record<string, any>[] = [];
      const searchOptions: SearchOptions = {
        maxResults,
        year,
        author,
        journal,
        category,
        days,
        fetchDetails,
        fieldsOfStudy,
        sortBy,
        sortOrder,
        ...(operation ? { operationContext: operation } : {})
      };

      if (platform === 'all') {
        try {
          const platformResults = await searchers.crossref.search(query, searchOptions);
          results.push(...platformResults.map((paper: Paper) => PaperFactory.toDict(paper)));
        } catch (error) {
          logDebug('Error searching crossref:', error);
          try {
            const platformResults = await searchers.arxiv.search(query, searchOptions);
            results.push(...platformResults.map((paper: Paper) => PaperFactory.toDict(paper)));
          } catch (fallbackError) {
            logDebug('Error with arxiv fallback:', fallbackError);
          }
        }
      } else {
        const searcher = (searchers as any)[platform];
        if (!searcher) {
          throw new Error(`Unsupported platform: ${platform}`);
        }

        const platformResults = platform === 'webofscience' || platform === 'wos'
          ? await searchers.webofscience.search(query, { ...searchOptions, apiProduct: 'starter', discoverAccess: false } as any)
          : await (searcher as PaperSource).search(query, searchOptions);
        results.push(...platformResults.map((paper: Paper) => PaperFactory.toDict(paper)));
      }

      return jsonTextResponse(`Found ${results.length} papers.\n\n${JSON.stringify(results, null, 2)}`);
    }

    case 'search_arxiv': {
      const { query, maxResults, category, author, year, sortBy, sortOrder } = args;
      const results = await searchers.arxiv.search(query, {
        maxResults,
        category,
        author,
        year,
        sortBy,
        sortOrder
      });

      return jsonTextResponse(
        `Found ${results.length} arXiv papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'search_webofscience': {
      const { query, maxResults, year, author, journal, sortBy, sortOrder, apiProduct, recordView, discoverAccess, discoverAccessMaxItems } = args;
      const results = await searchers.webofscience.search(query, {
        maxResults,
        year,
        author,
        journal,
        sortBy,
        sortOrder,
        apiProduct,
        recordView,
        discoverAccess,
        discoverAccessMaxItems,
        ...(operation ? { operationContext: operation } : {})
      } as any);

      return jsonTextResponse(
        `Found ${results.length} Web of Science papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'get_webofscience_related_records': {
      const { uid, relation, maxResults, firstRecord, recordView } = args;
      const result = await searchers.webofscience.getRelatedRecords(uid, relation, {
        maxResults,
        firstRecord,
        recordView
      });
      const itemType = relation === 'references' ? 'reference' : 'paper';
      const items = relation === 'references'
        ? result.items
        : (result.items as Paper[]).map(paper => PaperFactory.toDict(paper));
      return jsonTextResponse(JSON.stringify({
        provider: 'webofscience-expanded',
        relation,
        itemType,
        queryResult: result.queryResult,
        items
      }, null, 2));
    }

    case 'search_pubmed': {
      const { query, maxResults, year, author, journal, publicationType, sortBy } = args;

      const results = await searchers.pubmed.search(query, {
        maxResults,
        year,
        author,
        journal,
        publicationType,
        sortBy
      });

      const rateStatus = searchers.pubmed.getRateLimiterStatus();
      const apiKeyStatus = searchers.pubmed.hasApiKey() ? 'configured' : 'not configured';
      const rateLimit = searchers.pubmed.hasApiKey() ? '10 requests/second' : '3 requests/second';

      return jsonTextResponse(
        `Found ${results.length} PubMed papers.\n\nAPI Status: ${apiKeyStatus} (${rateLimit})\nRate Limiter: ${rateStatus.availableTokens}/${rateStatus.maxTokens} tokens available\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'search_biorxiv': {
      const { query, maxResults, days, category } = args;
      const results = await searchers.biorxiv.search(query, {
        maxResults,
        days,
        category
      });

      return jsonTextResponse(
        `Found ${results.length} bioRxiv papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'search_medrxiv': {
      const { query, maxResults, days, category } = args;
      const results = await searchers.medrxiv.search(query, {
        maxResults,
        days,
        category
      });

      return jsonTextResponse(
        `Found ${results.length} medRxiv papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'search_semantic_scholar': {
      const { query, maxResults, year, fieldsOfStudy } = args;
      const results = await searchers.semantic.search(query, {
        maxResults,
        year,
        fieldsOfStudy
      });

      const rateStatus = searchers.semantic.getRateLimiterStatus();
      const apiKeyStatus = searchers.semantic.hasApiKey()
        ? 'configured'
        : 'not configured (using free tier)';
      const rateLimit = searchers.semantic.hasApiKey() ? '200 requests/minute' : '20 requests/minute';

      return jsonTextResponse(
        `Found ${results.length} Semantic Scholar papers.\n\nAPI Status: ${apiKeyStatus} (${rateLimit})\nRate Limiter: ${rateStatus.availableTokens}/${rateStatus.maxTokens} tokens available\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'search_iacr': {
      const { query, maxResults, fetchDetails } = args;
      const results = await searchers.iacr.search(query, { maxResults, fetchDetails });

      return jsonTextResponse(
        `Found ${results.length} IACR ePrint papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'download_paper': {
      const { paperId, platform, savePath } = args;
      const pathResult = sanitizeDownloadPath(savePath, './downloads');
      if (!pathResult.valid) {
        throw new Error(pathResult.error || 'Invalid save path');
      }
      const resolvedSavePath = pathResult.sanitized;

      const searcher = (searchers as any)[platform];
      if (!searcher) {
        throw new Error(`Unsupported platform for download: ${platform}`);
      }

      if (!searcher.getCapabilities().download) {
        throw new Error(`Platform ${platform} does not support PDF download`);
      }

      const notice = platform === 'scihub' && typeof searcher.consumeComplianceNotice === 'function'
        ? searcher.consumeComplianceNotice()
        : undefined;
      const filePath = await searcher.downloadPdf(paperId, {
        savePath: resolvedSavePath,
        ...(operation ? { operationContext: operation } : {})
      });
      return jsonTextResponse(`${notice ? `${notice}\n\n` : ''}PDF downloaded successfully to: ${filePath}`);
    }

    case 'search_google_scholar': {
      const { query, maxResults, yearLow, yearHigh, author } = args;
      const results = await searchers.googlescholar.search(query, {
        maxResults,
        yearLow,
        yearHigh,
        author,
        ...(operation ? { operationContext: operation } : {})
      } as any);

      return jsonTextResponse(
        `Found ${results.length} Google Scholar papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'get_paper_by_doi': {
      const { doi, platform } = args;
      const doiResult = sanitizeDoi(doi);
      if (!doiResult.valid) {
        throw new Error(doiResult.error || 'Invalid DOI format');
      }
      const cleanDoi = doiResult.sanitized;
      const results: Record<string, any>[] = [];

      if (platform === 'all') {
        for (const [platformName, searcher] of getBusinessPlatformEntries(searchers)) {
          try {
            const paper = await (searcher as PaperSource).getPaperByDoi(cleanDoi, operation ? { operationContext: operation } : undefined);
            if (paper) {
              results.push(PaperFactory.toDict(paper));
            }
          } catch (error) {
            logDebug(`Error getting paper by DOI from ${platformName}:`, error);
          }
        }
      } else {
        const searcher = (searchers as any)[platform];
        if (!searcher) {
          throw new Error(`Unsupported platform: ${platform}`);
        }
        const paper = await searcher.getPaperByDoi(cleanDoi, operation ? { operationContext: operation } : undefined);
        if (paper) {
          results.push(PaperFactory.toDict(paper));
        }
      }

      if (results.length === 0) {
        return jsonTextResponse(`No paper found with DOI: ${cleanDoi}`);
      }
      return jsonTextResponse(`Found ${results.length} paper(s) with DOI ${cleanDoi}:\n\n${JSON.stringify(results, null, 2)}`);
    }

    case 'discover_paper_access': {
      const { doi, verifyPdf } = args;
      const doiResult = sanitizeDoi(doi);
      if (!doiResult.valid) {
        throw new Error(doiResult.error || 'Invalid DOI format');
      }
      const discoveryPaper = {
        paperId: `DOI:${doiResult.sanitized}`,
        title: 'DOI public access discovery',
        authors: [],
        abstract: '',
        doi: doiResult.sanitized,
        publishedDate: null,
        pdfUrl: '',
        url: '',
        source: 'doi'
      } as Paper;
      const [enriched] = await searchers.publicAccess.enrich([discoveryPaper], {
        verifyPdf,
        ...(operation ? { operation } : {})
      });
      return jsonTextResponse(JSON.stringify({
        doi: doiResult.sanitized,
        accessDiscovery: enriched.extra?.accessDiscovery,
        pdfUrl: enriched.pdfUrl || undefined
      }));
    }

    case 'search_scihub': {
      const { doiOrUrl, downloadPdf, savePath } = args;
      const pathResult = sanitizeDownloadPath(savePath, './downloads');
      if (!pathResult.valid) {
        throw new Error(pathResult.error || 'Invalid save path');
      }
      const resolvedSavePath = pathResult.sanitized;

      const results = await searchers.scihub.search(doiOrUrl, operation ? { operationContext: operation } : undefined);
      const notice = searchers.scihub.consumeComplianceNotice();
      if (results.length === 0) {
        return jsonTextResponse(`${notice ? `${notice}\n\n` : ''}No paper found on Sci-Hub for: ${doiOrUrl}`);
      }

      const paper = results[0];
      let responseText = `${notice ? `${notice}\n\n` : ''}Found paper on Sci-Hub:\n\n${JSON.stringify(PaperFactory.toDict(paper), null, 2)}`;

      if (downloadPdf && paper.pdfUrl) {
        try {
          const filePath = await searchers.scihub.downloadPdf(doiOrUrl, {
            savePath: resolvedSavePath,
            ...(operation ? { operationContext: operation } : {})
          });
          responseText += `\n\nPDF downloaded successfully to: ${filePath}`;
        } catch (downloadError: any) {
          responseText += `\n\nFailed to download PDF: ${sanitizeSensitiveText(downloadError.message || 'Unknown download error')}`;
        }
      }

      return jsonTextResponse(responseText);
    }

    case 'check_scihub_mirrors': {
      const { forceCheck } = args;

      if (forceCheck) {
        await searchers.scihub.forceHealthCheck(operation?.signal);
      }
      const mirrorStatus = searchers.scihub.getMirrorStatus();
      return jsonTextResponse(`Sci-Hub Mirror Status:\n\n${JSON.stringify(mirrorStatus, null, 2)}`);
    }

    case 'search_sciencedirect': {
      const { query, maxResults, year, author, journal, openAccess } = args;
      if (!process.env.ELSEVIER_API_KEY) {
        throw new Error('Elsevier API key not configured. Please set ELSEVIER_API_KEY environment variable.');
      }
      const results = await searchers.sciencedirect.search(query, {
        maxResults,
        year,
        author,
        journal,
        openAccess
      });

      return jsonTextResponse(
        `Found ${results.length} ScienceDirect papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'search_springer': {
      const { query, maxResults, year, author, journal, subject, openAccess, type } = args;
      if (!process.env.SPRINGER_API_KEY) {
        throw new Error('Springer API key not configured. Please set SPRINGER_API_KEY environment variable.');
      }

      const results = await searchers.springer.search(query, {
        maxResults,
        year,
        author,
        journal,
        subject,
        openAccess,
        type
      } as any);

      return jsonTextResponse(
        `Found ${results.length} Springer papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'search_scopus': {
      const { query, maxResults, year, author, journal, affiliation, subject, openAccess, documentType } = args;
      const results = await searchers.scopus.search(query, {
        maxResults,
        year,
        author,
        journal,
        affiliation,
        subject,
        openAccess,
        documentType
      } as any);

      return jsonTextResponse(
        `Found ${results.length} Scopus papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'search_crossref': {
      const { query, maxResults, year, author, sortBy, sortOrder } = args;
      const results = await searchers.crossref.search(query, {
        maxResults,
        year,
        author,
        sortBy,
        sortOrder
      });

      return jsonTextResponse(
        `Found ${results.length} Crossref papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
    }

    case 'get_citations': {
      const { doi, forceRefresh } = args;
      const doiResult = sanitizeDoi(doi);
      if (!doiResult.valid) {
        throw new Error(doiResult.error || 'Invalid DOI format');
      }

      const data = await citationService.getCitationDataByDoi(doiResult.sanitized, forceRefresh);

      if (!data) {
        return jsonTextResponse(`No citation data found for DOI: ${doiResult.sanitized}`);
      }

      const summary = {
        paper_id: data.paperId,
        title: data.title,
        citation_count: data.citationCount,
        reference_count: data.referenceCount,
        influential_citation_count: data.influentialCitationCount,
        year: data.year,
        venue: data.venue,
        doi: data.doi,
        url: data.url,
        authors: data.authors?.map(a => a.authorId ? `${a.name} (${a.authorId})` : a.name) ?? []
      };

      return jsonTextResponse(`Citations for ${doiResult.sanitized}:\n\n${JSON.stringify(summary, null, 2)}`);
    }

    case 'get_platform_status': {
      const { validate } = args;
      const statusInfo: any[] = [];

      for (const [platformName, searcher] of getBusinessPlatformEntries(searchers)) {

        if (platformName === 'webofscience') {
          const wosStatus = await searchers.webofscience.getStatus(validate);
          statusInfo.push({
            platform: platformName,
            baseUrl: searchers.webofscience.getBaseUrl(),
            capabilities: searchers.webofscience.getCapabilities(),
            apiKeyStatus: wosStatus.starter.apiKeyStatus,
            ...wosStatus
          });
          continue;
        }

        const capabilities = (searcher as PaperSource).getCapabilities();
        const hasApiKey = (searcher as PaperSource).hasApiKey();

        let apiKeyStatus = 'not_required';
        if (capabilities.requiresApiKey) {
          if (hasApiKey) {
            if (validate) {
              try {
                const isValid = await (searcher as PaperSource).validateApiKey();
                apiKeyStatus = isValid ? 'valid' : 'invalid';
              } catch {
                apiKeyStatus = 'unknown';
              }
            } else {
              apiKeyStatus = 'configured';
            }
          } else {
            apiKeyStatus = 'missing';
          }
        }

        let additionalInfo: any = {};
        if (platformName === 'scihub') {
          const mirrorStatus = searchers.scihub.getMirrorStatus();
          additionalInfo = {
            ...searchers.scihub.getStatus(),
            mirrorCount: mirrorStatus.length,
            workingMirrors: mirrorStatus.filter(m => m.status === 'working').length
          };
        }

        statusInfo.push({
          platform: platformName,
          baseUrl: (searcher as PaperSource).getBaseUrl(),
          capabilities,
          apiKeyStatus,
          ...additionalInfo
        });
      }

      statusInfo.push({
        platform: 'scrapingant',
        ...(searchers.scrapingAnt?.getStatus() || searchers.webofscience.getScrapingAntStatus())
      });
      return jsonTextResponse(`Platform Status:\n\n${JSON.stringify(statusInfo, null, 2)}`);
    }

    default:
      throw new Error(`Unknown tool: ${toolNameRaw}`);
  }
}
