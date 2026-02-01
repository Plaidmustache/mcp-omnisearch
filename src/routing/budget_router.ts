/**
 * Budget-aware search router
 * Routes requests through prioritized provider stack, maximizing free tier usage
 */

import { is_api_key_valid } from '../common/utils.js';
import type { SearchProvider, SearchResult } from '../common/types.js';
import { config, PROVIDER_LIMITS, type ProviderName } from '../config/env.js';
import { createStorage, type UsageStorage } from '../storage/index.js';

// Providers that support budget routing
import { BraveSearchProvider } from '../providers/search/brave/index.js';
import { ExaSearchProvider } from '../providers/search/exa/index.js';
import { TavilySearchProvider } from '../providers/search/tavily/index.js';
import { JinaSearchProvider } from '../providers/search/jina_search/index.js';
import { SerperSearchProvider } from '../providers/search/serper/index.js';
import { YouComSearchProvider } from '../providers/search/youcom/index.js';

export interface RouteOptions {
	query: string;
	limit?: number;
	preferGoogle?: boolean;
	includeContent?: boolean;
}

export interface BudgetStats {
	monthly: Record<string, { used: number; limit: number; remaining: number }>;
	lifetime: Record<string, { used: number; limit: number; remaining: number }>;
	paidApis: Record<string, { used: number; costPerQuery: number; estimatedCost: number }>;
	paid: Record<string, number>;
	health: Record<string, { status: 'healthy' | 'degraded' | 'down'; failures: number; cooldownUntil?: string }>;
}

export interface RouteResult {
	results: SearchResult[];
	provider: string;
	usedPaidTier: boolean;
}

// Circuit breaker state
interface CircuitState {
	failures: number;
	lastFailure: number;
	cooldownUntil: number;
}

// Circuit breaker config
const CIRCUIT_BREAKER = {
	maxFailures: 3,
	cooldownMs: 5 * 60 * 1000, // 5 minutes
};

export class BudgetRouter {
	private storage: UsageStorage;
	private providers: Map<ProviderName, SearchProvider>;
	private circuitState: Map<ProviderName, CircuitState> = new Map();

	// Default priority order: Monthly providers first, then lifetime
	private defaultStack: ProviderName[] = [
		'brave',
		'tavily',
		'exa',
		'jina_search',
		'serper',
		'youcom',
	];

	// Google-preferred order (Serper provides Google results)
	private googleStack: ProviderName[] = [
		'serper',
		'brave',
		'tavily',
		'exa',
		'jina_search',
		'youcom',
	];

	constructor() {
		this.storage = createStorage();
		this.providers = new Map();

		// Only initialize providers that have valid API keys
		if (is_api_key_valid(config.search.brave.api_key, 'brave')) {
			this.providers.set('brave', new BraveSearchProvider());
		}
		if (is_api_key_valid(config.search.tavily.api_key, 'tavily')) {
			this.providers.set('tavily', new TavilySearchProvider());
		}
		if (is_api_key_valid(config.search.exa.api_key, 'exa')) {
			this.providers.set('exa', new ExaSearchProvider());
		}
		if (is_api_key_valid(config.search.jina_search.api_key, 'jina_search')) {
			this.providers.set('jina_search', new JinaSearchProvider());
		}
		if (is_api_key_valid(config.search.serper.api_key, 'serper')) {
			this.providers.set('serper', new SerperSearchProvider());
		}
		if (is_api_key_valid(config.search.youcom.api_key, 'youcom')) {
			this.providers.set('youcom', new YouComSearchProvider());
		}
	}

	/**
	 * Generate the storage key for a provider
	 * Monthly providers: "brave:2026-02"
	 * Lifetime providers: "exa:lifetime"
	 * Paid providers: "perplexity:paid"
	 */
	private getStorageKey(provider: ProviderName): string {
		const limitConfig = PROVIDER_LIMITS[provider];
		if (limitConfig.type === 'monthly') {
			const month = new Date().toISOString().slice(0, 7); // "2026-02"
			return `${provider}:${month}`;
		}
		if (limitConfig.type === 'paid') {
			return `${provider}:paid`;
		}
		return `${provider}:lifetime`;
	}

	/**
	 * Check if a provider has remaining free quota
	 */
	private async hasQuota(provider: ProviderName): Promise<boolean> {
		const key = this.getStorageKey(provider);
		const used = await this.storage.get(key);
		const limit = PROVIDER_LIMITS[provider].limit;
		return used < limit;
	}

	/**
	 * Check if circuit breaker is open (provider should be skipped)
	 */
	private isCircuitOpen(provider: ProviderName): boolean {
		const state = this.circuitState.get(provider);
		if (!state) return false;

		// If in cooldown, check if cooldown has expired
		if (state.cooldownUntil > Date.now()) {
			return true; // Still in cooldown, skip this provider
		}

		// Cooldown expired, reset state
		if (state.failures >= CIRCUIT_BREAKER.maxFailures) {
			this.circuitState.delete(provider);
		}
		return false;
	}

	/**
	 * Record a provider failure (for circuit breaker)
	 */
	private recordFailure(provider: ProviderName): void {
		const state = this.circuitState.get(provider) || {
			failures: 0,
			lastFailure: 0,
			cooldownUntil: 0,
		};

		state.failures++;
		state.lastFailure = Date.now();

		// If max failures reached, enter cooldown
		if (state.failures >= CIRCUIT_BREAKER.maxFailures) {
			state.cooldownUntil = Date.now() + CIRCUIT_BREAKER.cooldownMs;
			console.error(
				`[circuit-breaker] ${provider} disabled for ${CIRCUIT_BREAKER.cooldownMs / 1000}s after ${state.failures} failures`,
			);
		}

		this.circuitState.set(provider, state);
	}

	/**
	 * Record a provider success (reset circuit breaker)
	 */
	private recordSuccess(provider: ProviderName): void {
		this.circuitState.delete(provider);
	}

	/**
	 * Get health status for a provider
	 */
	private getHealthStatus(provider: ProviderName): { status: 'healthy' | 'degraded' | 'down'; failures: number; cooldownUntil?: string } {
		const state = this.circuitState.get(provider);
		if (!state) {
			return { status: 'healthy', failures: 0 };
		}

		if (state.cooldownUntil > Date.now()) {
			return {
				status: 'down',
				failures: state.failures,
				cooldownUntil: new Date(state.cooldownUntil).toISOString(),
			};
		}

		if (state.failures > 0) {
			return { status: 'degraded', failures: state.failures };
		}

		return { status: 'healthy', failures: 0 };
	}

	/**
	 * Record a successful search
	 */
	private async recordUsage(
		provider: ProviderName,
		paid: boolean = false,
	): Promise<void> {
		const key = this.getStorageKey(provider);
		await this.storage.increment(key);

		if (paid) {
			await this.storage.increment(`${provider}:paid`);
		}
	}

	/**
	 * Record usage for explicit provider selection (public method)
	 * For paid-only providers like perplexity, set isPaidProvider=true
	 */
	async recordExplicitUsage(provider: string, isPaidProvider: boolean = false): Promise<void> {
		if (provider in PROVIDER_LIMITS) {
			const limitConfig = PROVIDER_LIMITS[provider as ProviderName];
			if (limitConfig.type === 'paid' || isPaidProvider) {
				// Paid-only provider - just increment the paid key directly
				await this.storage.increment(`${provider}:paid`);
			} else {
				await this.recordUsage(provider as ProviderName, false);
			}
		}
	}

	/**
	 * Get available providers (those with API keys configured)
	 */
	getAvailableProviders(): ProviderName[] {
		return Array.from(this.providers.keys());
	}

	/**
	 * Route a search request to the best available provider
	 */
	async route(options: RouteOptions): Promise<RouteResult> {
		const stack = options.preferGoogle ? this.googleStack : this.defaultStack;

		// Special case: include_content always uses Jina Search
		if (options.includeContent) {
			const jinaProvider = this.providers.get('jina_search');
			if (jinaProvider) {
				const results = await jinaProvider.search({
					query: options.query,
					limit: options.limit,
					include_content: true,
				} as any);
				await this.recordUsage('jina_search', false);
				return { results, provider: 'jina_search', usedPaidTier: false };
			}
			throw new Error(
				'Jina Search API key required for include_content option',
			);
		}

		// Try each provider in order
		for (const providerName of stack) {
			const provider = this.providers.get(providerName);
			if (!provider) continue; // Provider not configured (no API key)

			// Skip if circuit breaker is open
			if (this.isCircuitOpen(providerName)) {
				console.error(`[budget-router] ${providerName} skipped (circuit open)`);
				continue;
			}

			const hasQuota = await this.hasQuota(providerName);

			if (hasQuota) {
				try {
					const results = await provider.search({
						query: options.query,
						limit: options.limit,
					});
					await this.recordUsage(providerName, false);
					this.recordSuccess(providerName); // Reset circuit breaker on success
					return { results, provider: providerName, usedPaidTier: false };
				} catch (error) {
					// Provider failed, record failure and continue to next
					this.recordFailure(providerName);
					console.error(
						`[budget-router] ${providerName} failed, trying next:`,
						error,
					);
					continue;
				}
			}
		}

		// All free tiers exhausted - use paid fallback
		// Jina Search is cheapest ($0.50/1K), Serper for Google queries ($1/1K)
		const paidProvider = options.preferGoogle ? 'serper' : 'jina_search';
		const provider = this.providers.get(paidProvider);

		if (provider) {
			const results = await provider.search({
				query: options.query,
				limit: options.limit,
			});
			await this.recordUsage(paidProvider, true);
			return { results, provider: paidProvider, usedPaidTier: true };
		}

		throw new Error(
			'No search providers available. Please configure at least one API key.',
		);
	}

	/**
	 * Get current usage stats (for check_search_budget tool)
	 */
	async getUsageStats(): Promise<BudgetStats> {
		const allUsage = await this.storage.getAll();
		const currentMonth = new Date().toISOString().slice(0, 7);

		const stats: BudgetStats = {
			monthly: {},
			lifetime: {},
			paidApis: {},
			paid: {},
			health: {},
		};

		for (const [provider, limitConfig] of Object.entries(PROVIDER_LIMITS)) {
			const providerName = provider as ProviderName;

			if (limitConfig.type === 'monthly') {
				const key = `${provider}:${currentMonth}`;
				const used = allUsage[key] ?? 0;
				stats.monthly[provider] = {
					used,
					limit: limitConfig.limit,
					remaining: Math.max(0, limitConfig.limit - used),
				};
			} else if (limitConfig.type === 'lifetime') {
				const key = `${provider}:lifetime`;
				const used = allUsage[key] ?? 0;
				stats.lifetime[provider] = {
					used,
					limit: limitConfig.limit,
					remaining: Math.max(0, limitConfig.limit - used),
				};
			} else if (limitConfig.type === 'paid') {
				// Paid APIs - no free tier, just track usage
				const key = `${provider}:paid`;
				const used = allUsage[key] ?? 0;
				const costPerQuery = (limitConfig as any).cost_per_query || 0;
				stats.paidApis[provider] = {
					used,
					costPerQuery,
					estimatedCost: used * costPerQuery,
				};
			}

			// Paid usage (for providers with free tier that went over)
			if (limitConfig.type !== 'paid') {
				const paidKey = `${provider}:paid`;
				stats.paid[provider] = allUsage[paidKey] ?? 0;
			}

			// Health status (circuit breaker) - only for routed providers
			if (limitConfig.type !== 'paid') {
				stats.health[provider] = this.getHealthStatus(providerName);
			}
		}

		return stats;
	}
}
