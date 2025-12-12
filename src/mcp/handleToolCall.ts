import type { Searchers } from './searchers.js';
import type { ToolName } from './schemas.js';
import { parseToolArgs } from './schemas.js';
import { PaperFactory, type Paper } from '../models/Paper.js';
import { PaperSource, type SearchOptions } from '../platforms/PaperSource.js';
import { logDebug } from '../utils/Logger.js';

function jsonTextResponse(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text
      }
    ]
  };
}

export async function handleToolCall(
  toolNameRaw: string,
  rawArgs: unknown,
  searchers: Searchers
) {
  const toolName = toolNameRaw as ToolName;
  const args = parseToolArgs(toolName, rawArgs);

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
        sortOrder
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

        const platformResults = await (searcher as PaperSource).search(query, searchOptions);
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
      const { query, maxResults, year, author, journal, sortBy, sortOrder } = args;
      if (!process.env.WOS_API_KEY) {
        throw new Error('Web of Science API key not configured. Please set WOS_API_KEY environment variable.');
      }

      const results = await searchers.webofscience.search(query, {
        maxResults,
        year,
        author,
        journal,
        sortBy,
        sortOrder
      } as any);

      return jsonTextResponse(
        `Found ${results.length} Web of Science papers.\n\n${JSON.stringify(
          results.map((paper: Paper) => PaperFactory.toDict(paper)),
          null,
          2
        )}`
      );
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
      const resolvedSavePath = savePath || './downloads';

      const searcher = (searchers as any)[platform];
      if (!searcher) {
        throw new Error(`Unsupported platform for download: ${platform}`);
      }

      if (!searcher.getCapabilities().download) {
        throw new Error(`Platform ${platform} does not support PDF download`);
      }

      const filePath = await searcher.downloadPdf(paperId, { savePath: resolvedSavePath });
      return jsonTextResponse(`PDF downloaded successfully to: ${filePath}`);
    }

    case 'search_google_scholar': {
      const { query, maxResults, yearLow, yearHigh, author } = args;
      const results = await searchers.googlescholar.search(query, {
        maxResults,
        yearLow,
        yearHigh,
        author
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
      const results: Record<string, any>[] = [];

      if (platform === 'all') {
        for (const [platformName, searcher] of Object.entries(searchers)) {
          if (platformName === 'wos' || platformName === 'scholar') continue;
          try {
            const paper = await (searcher as PaperSource).getPaperByDoi(doi);
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
        const paper = await searcher.getPaperByDoi(doi);
        if (paper) {
          results.push(PaperFactory.toDict(paper));
        }
      }

      if (results.length === 0) {
        return jsonTextResponse(`No paper found with DOI: ${doi}`);
      }
      return jsonTextResponse(`Found ${results.length} paper(s) with DOI ${doi}:\n\n${JSON.stringify(results, null, 2)}`);
    }

    case 'search_scihub': {
      const { doiOrUrl, downloadPdf, savePath } = args;
      const resolvedSavePath = savePath || './downloads';

      const results = await searchers.scihub.search(doiOrUrl);
      if (results.length === 0) {
        return jsonTextResponse(`No paper found on Sci-Hub for: ${doiOrUrl}`);
      }

      const paper = results[0];
      let responseText = `Found paper on Sci-Hub:\n\n${JSON.stringify(PaperFactory.toDict(paper), null, 2)}`;

      if (downloadPdf && paper.pdfUrl) {
        try {
          const filePath = await searchers.scihub.downloadPdf(doiOrUrl, { savePath: resolvedSavePath });
          responseText += `\n\nPDF downloaded successfully to: ${filePath}`;
        } catch (downloadError: any) {
          responseText += `\n\nFailed to download PDF: ${downloadError.message}`;
        }
      }

      return jsonTextResponse(responseText);
    }

    case 'check_scihub_mirrors': {
      const { forceCheck } = args;

      if (forceCheck) {
        await searchers.scihub.forceHealthCheck();
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

    case 'search_wiley': {
      return jsonTextResponse(
        `DEPRECATED: Wiley TDM API does not support keyword search.\n\n` +
          `To access Wiley content:\n` +
          `1. Use search_crossref to find Wiley articles (filter by publisher if needed)\n` +
          `2. Use download_paper with platform="wiley" and the DOI to download the PDF\n\n` +
          `Example: download_paper(paperId="10.1111/jtsb.12390", platform="wiley")`
      );
    }

    case 'search_scopus': {
      const { query, maxResults, year, author, journal, affiliation, subject, openAccess, documentType } = args;
      if (!process.env.ELSEVIER_API_KEY) {
        throw new Error('Elsevier API key not configured. Please set ELSEVIER_API_KEY environment variable.');
      }

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

    case 'get_platform_status': {
      const { validate } = args;
      const statusInfo: any[] = [];

      for (const [platformName, searcher] of Object.entries(searchers)) {
        if (platformName === 'wos' || platformName === 'scholar') continue;

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
            mirrorCount: mirrorStatus.length,
            workingMirrors: mirrorStatus.filter(m => m.status === 'Working').length
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

      return jsonTextResponse(`Platform Status:\n\n${JSON.stringify(statusInfo, null, 2)}`);
    }

    default:
      throw new Error(`Unknown tool: ${toolNameRaw}`);
  }
}
