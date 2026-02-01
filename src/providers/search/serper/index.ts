/**
 * Serper Search Provider
 * API: POST https://google.serper.dev/search
 * Returns Google search results
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

interface SerperOrganicResult {
	title: string;
	link: string;
	snippet: string;
	position: number;
	date?: string;
	sitelinks?: Array<{ title: string; link: string }>;
}

interface SerperResponse {
	organic: SerperOrganicResult[];
	searchParameters?: {
		q: string;
		type: string;
		engine: string;
	};
}

export class SerperSearchProvider implements SearchProvider {
	name = 'serper';
	description =
		'Search Google using Serper API. Returns high-quality Google search results. Best for when you need Google-specific results.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(config.search.serper.api_key, this.name);

		const search_request = async () => {
			const query = sanitize_query(params.query);
			const url = `${config.search.serper.base_url}/search`;

			const response = await http_json<SerperResponse>(this.name, url, {
				method: 'POST',
				headers: {
					'X-API-KEY': api_key,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					q: query,
					num: params.limit || 10,
				}),
				signal: AbortSignal.timeout(config.search.serper.timeout),
			});

			if (!response?.organic) {
				throw new ProviderError(
					ErrorType.API_ERROR,
					'Invalid response format from Serper',
					this.name,
				);
			}

			return response.organic.map((result) => ({
				title: result.title || '',
				url: result.link || '',
				snippet: result.snippet || '',
				position: result.position,
				source_provider: this.name,
				metadata: result.date
					? { date: result.date, has_sitelinks: !!result.sitelinks?.length }
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
