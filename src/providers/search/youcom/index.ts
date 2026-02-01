/**
 * You.com Search Provider
 * API: GET https://api.ydc-index.io/search?query=
 * Returns web search results with generous free tier
 */

import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import {
	handle_provider_error,
	retry_with_backoff,
	sanitize_query,
	validate_api_key,
} from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface YouComHit {
	title: string;
	url: string;
	description: string;
	snippets?: string[];
}

interface YouComResponse {
	hits: YouComHit[];
	latency?: number;
}

export class YouComSearchProvider implements SearchProvider {
	name = 'youcom';
	description =
		'Search using You.com API. Provides diverse web search results with a generous free tier.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(config.search.youcom.api_key, this.name);

		const search_request = async () => {
			const query = sanitize_query(params.query);
			const url = new URL(`${config.search.youcom.base_url}/search`);
			url.searchParams.set('query', query);

			const response = await http_json<YouComResponse>(
				this.name,
				url.toString(),
				{
					method: 'GET',
					headers: {
						'X-API-Key': api_key,
					},
					signal: AbortSignal.timeout(config.search.youcom.timeout),
				},
			);

			if (!response?.hits) {
				throw new ProviderError(
					ErrorType.API_ERROR,
					'Invalid response format from You.com',
					this.name,
				);
			}

			const limit = params.limit || 10;
			return response.hits.slice(0, limit).map((result, index) => ({
				title: result.title || '',
				url: result.url || '',
				snippet:
					result.description || result.snippets?.join(' ') || '',
				position: index + 1,
				source_provider: this.name,
				metadata: result.snippets?.length
					? { snippet_count: result.snippets.length }
					: undefined,
			}));
		};

		try {
			return await retry_with_backoff(search_request);
		} catch (error: unknown) {
			handle_provider_error(error, this.name, 'fetch search results');
		}
	}
}
