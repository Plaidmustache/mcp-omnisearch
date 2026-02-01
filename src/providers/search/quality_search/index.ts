import { http_json } from '../../../common/http.js';
import {
  SearchProvider,
  SearchResult,
  BaseSearchParams,
  ErrorType,
  ProviderError,
} from '../../../common/types.js';
import {
  handle_provider_error,
  validate_api_key,
} from '../../../common/utils.js';
import { config } from '../../../config/env.js';
import { BudgetRouter } from '../../../routing/budget_router.js';

interface JinaRerankerRequest {
  model: string;
  query: string;
  documents: string[];
  top_n: number;
}

interface JinaRerankerResponse {
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
  usage?: {
    total_tokens: number;
  };
}

interface QualitySearchParams extends BaseSearchParams {
  limit?: number;
}

export class QualitySearchProvider implements SearchProvider {
  name = 'quality_search';
  description =
    'High-quality search. Searches multiple sources and reranks for relevance. Use ONLY when user explicitly says "quality search".';

  private sourceProviders: SearchProvider[] = [];
  private budgetRouter: BudgetRouter;

  constructor(
    sourceProviders: SearchProvider[],
    budgetRouter?: BudgetRouter,
  ) {
    this.sourceProviders = sourceProviders;
    this.budgetRouter = budgetRouter || new BudgetRouter();
  }

  async search(params: QualitySearchParams): Promise<SearchResult[]> {
    const api_key = validate_api_key(
      config.search.jina_search.api_key,
      'jina_reranker',
    );

    const limit = params.limit || 10;
    const perProviderLimit = Math.ceil(limit * 1.5); // Fetch more to have good candidates

    try {
      // 1. Fetch from multiple providers in parallel
      const providerResults = await Promise.allSettled(
        this.sourceProviders.map((provider) =>
          provider.search({
            query: params.query,
            limit: perProviderLimit,
          }),
        ),
      );

      // 2. Collect all successful results and track usage
      const allResults: SearchResult[] = [];
      const successfulProviders: string[] = [];
      
      for (let i = 0; i < providerResults.length; i++) {
        const result = providerResults[i];
        if (result.status === 'fulfilled' && result.value.length > 0) {
          allResults.push(...result.value);
          // Track which provider succeeded
          const providerName = this.sourceProviders[i].name;
          successfulProviders.push(providerName);
        }
      }

      // Record usage for each successful provider
      for (const providerName of successfulProviders) {
        await this.budgetRouter.recordExplicitUsage(providerName);
      }

      if (allResults.length === 0) {
        throw new ProviderError(
          ErrorType.API_ERROR,
          'All source providers failed to return results',
          this.name,
        );
      }

      // 3. Deduplicate by URL
      const uniqueResults = this.deduplicateByUrl(allResults);

      // If we have very few results, skip reranking
      if (uniqueResults.length <= 3) {
        return uniqueResults;
      }

      // 4. Send to Jina Reranker
      const rerankedResults = await this.rerank(
        api_key,
        params.query,
        uniqueResults,
        limit,
      );

      return rerankedResults;
    } catch (error: unknown) {
      // If reranking fails, try to return unranked results
      if (error instanceof ProviderError) {
        throw error;
      }
      handle_provider_error(error, this.name, 'search');
    }
  }

  private deduplicateByUrl(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    const unique: SearchResult[] = [];

    for (const result of results) {
      const normalizedUrl = result.url.toLowerCase().replace(/\/$/, '');
      if (!seen.has(normalizedUrl)) {
        seen.add(normalizedUrl);
        unique.push(result);
      }
    }

    return unique;
  }

  private async rerank(
    api_key: string,
    query: string,
    results: SearchResult[],
    topN: number,
  ): Promise<SearchResult[]> {
    // Prepare documents for reranking (use title + snippet)
    const documents = results.map(
      (r) => `${r.title}\n${r.snippet}`,
    );

    const requestBody: JinaRerankerRequest = {
      model: 'jina-reranker-v3',
      query: query,
      documents: documents,
      top_n: Math.min(topN, results.length),
    };

    try {
      const response = await http_json<JinaRerankerResponse>(
        'jina_reranker',
        'https://api.jina.ai/v1/rerank',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${api_key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(30000),
        },
      );

      if (!response.results || !Array.isArray(response.results)) {
        throw new ProviderError(
          ErrorType.API_ERROR,
          'Invalid response format from Jina Reranker',
          this.name,
        );
      }

      // Track token usage if budget router available
      if (this.budgetRouter && response.usage?.total_tokens) {
        // Note: Reranker uses shared Jina token pool
        // We could track this separately if needed
        console.error(
          `[quality_search] Reranker used ${response.usage.total_tokens} tokens`,
        );
      }

      // Map reranked indices back to full results
      const rerankedResults: SearchResult[] = response.results.map(
        (r, position) => ({
          ...results[r.index],
          position: position + 1,
          relevance_score: r.relevance_score,
          source_provider: `${results[r.index].source_provider}+reranked`,
        }),
      );

      return rerankedResults;
    } catch (error) {
      console.error('[quality_search] Reranker failed, returning unranked results:', error);
      // Fallback: return unranked results
      return results.slice(0, topN);
    }
  }
}
