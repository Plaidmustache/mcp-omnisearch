/**
 * Jina Search Provider
 * API: https://s.jina.ai/{query}
 * Returns search results with optional full page content
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

interface JinaSearchParams extends BaseSearchParams {
	include_content?: boolean;
}

interface JinaSearchResult {
	title: string;
	url: string;
	description: string;
	content?: string;
}

interface JinaSearchResponse {
	data: JinaSearchResult[];
	code?: number;
	status?: number;
	message?: string;
}

export class JinaSearchProvider implements SearchProvider {
	name = 'jina_search';
	description =
		'Search the web using Jina Search API. Returns results with optional full page content. Best for when you need both search results and page content.';

	async search(params: JinaSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.jina_search.api_key,
			this.name,
		);

		const search_request = async () => {
			const query = sanitize_query(params.query);
			const encoded_query = encodeURIComponent(query);
			const url = `${config.search.jina_search.base_url}/${encoded_query}`;

			const response = await http_json<JinaSearchResponse>(this.name, url, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${api_key}`,
					Accept: 'application/json',
				},
				signal: AbortSignal.timeout(config.search.jina_search.timeout),
			});

			if (!response.data || !Array.isArray(response.data)) {
				throw new ProviderError(
					ErrorType.API_ERROR,
					`Invalid response format from Jina Search: ${response.message || 'no data'}`,
					this.name,
				);
			}

			const limit = params.limit || 10;
			return response.data.slice(0, limit).map((result, index) => ({
				title: result.title || '',
				url: result.url || '',
				snippet: result.description || '',
				content: params.include_content ? result.content : undefined,
				position: index + 1,
				source_provider: this.name,
				metadata: result.content
					? { has_content: true, content_length: result.content.length }
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
