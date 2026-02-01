import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../common/types.js';
import { BudgetRouter } from '../../routing/budget_router.js';
import { BraveSearchProvider } from '../search/brave/index.js';
import { ExaSearchProvider } from '../search/exa/index.js';
import { KagiSearchProvider } from '../search/kagi/index.js';
import { TavilySearchProvider } from '../search/tavily/index.js';

export type WebSearchProvider =
	| 'tavily'
	| 'brave'
	| 'kagi'
	| 'exa'
	| 'jina_search'
	| 'serper'
	| 'youcom';

export interface UnifiedWebSearchParams extends BaseSearchParams {
	provider?: WebSearchProvider; // Now optional - budget routing when not specified
	include_content?: boolean; // Request full page content (uses Jina Search)
}

export class UnifiedWebSearchProvider implements SearchProvider {
	name = 'web_search';
	description =
		'Search the web. Auto-routes through providers using budget-aware routing when no provider specified. Explicit providers: tavily (factual/citations), brave (privacy/operators), kagi (quality/operators), exa (AI-semantic), jina_search (content), serper (Google), youcom (diverse). Brave/Kagi support query operators like site:, filetype:, lang:, etc.';

	private providers: Map<WebSearchProvider, SearchProvider> = new Map();
	private budgetRouter: BudgetRouter;

	constructor() {
		// Legacy providers for explicit selection
		this.providers.set('tavily', new TavilySearchProvider());
		this.providers.set('brave', new BraveSearchProvider());
		this.providers.set('kagi', new KagiSearchProvider());
		this.providers.set('exa', new ExaSearchProvider());

		// Budget router handles automatic provider selection
		this.budgetRouter = new BudgetRouter();
	}

	/**
	 * Get the budget router instance (for check_search_budget tool)
	 */
	getBudgetRouter(): BudgetRouter {
		return this.budgetRouter;
	}

	async search(params: UnifiedWebSearchParams): Promise<SearchResult[]> {
		const { provider, include_content, ...searchParams } = params;

		// If explicit provider specified, use it directly (backward compatible)
		if (provider) {
			const selectedProvider = this.providers.get(provider);

			if (!selectedProvider) {
				throw new ProviderError(
					ErrorType.INVALID_INPUT,
					`Invalid provider: ${provider}. Valid options: ${Array.from(this.providers.keys()).join(', ')}`,
					this.name,
				);
			}

			const results = await selectedProvider.search(searchParams);
			// Track usage even for explicit provider selection
			await this.budgetRouter.recordExplicitUsage(provider);
			return results;
		}

		// Budget-aware routing when no provider specified
		const preferGoogle = params.query.toLowerCase().includes('google');
		const { results } = await this.budgetRouter.route({
			query: params.query,
			limit: params.limit,
			preferGoogle,
			includeContent: include_content,
		});

		return results;
	}
}
