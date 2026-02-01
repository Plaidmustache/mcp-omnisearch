# Budget-Aware Search Routing Implementation Plan

## Overview

This document outlines the implementation of budget-aware routing for mcp-omnisearch. The system automatically routes search requests through a prioritized stack of providers, preferring free tiers before falling back to paid options.

**Branch:** `feature/budget-aware-routing`
**Repository:** `/Users/malone/Projects/mcp-omnisearch`

---

## Goals

1. Maximize free tier usage across all search providers
2. Automatically failover when limits are reached
3. Track usage with optional Redis support (file fallback for universal compatibility)
4. Provide visibility into remaining budget via a new tool
5. Support special routing modes (Google-specific, quality, content-included)

---

## Provider Stack

### Priority Order (Default Flow)

| Priority | Provider | Free Tier | Paid Rate | Type |
|----------|----------|-----------|-----------|------|
| 1 | Brave | 2,000/month | — | Monthly |
| 2 | Tavily | 1,000/month | — | Monthly |
| 3 | Exa | ~2,000 one-time | — | Lifetime |
| 4 | Jina Search | 1,000 one-time | $0.50/1K | Lifetime |
| 5 | Serper | 2,500 one-time | $1.00/1K | Lifetime |
| 6 | You.com | ~16,000 one-time | Hard stop | Lifetime |

### Routing Logic

```
DEFAULT:
  Brave → Tavily → Exa → Jina Search → Serper → You.com → STOP

IF query contains "google" OR options.provider = "google":
  Brave → Tavily → Exa → Serper → Jina Search → You.com → STOP

IF options.quality = "high":
  → Perplexity Sonar (existing ai_search tool)

IF options.include_content = true:
  → Jina Search (bypasses budget stack, returns full page content)
```

---

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  web_search tool                                            │
│  └─► BudgetRouter                                           │
│       ├─► UsageStorage (Redis or File)                      │
│       └─► Providers                                         │
│            ├─► BraveSearchProvider      (existing)          │
│            ├─► TavilySearchProvider     (existing)          │
│            ├─► ExaSearchProvider        (existing)          │
│            ├─► JinaSearchProvider       (NEW)               │
│            ├─► SerperSearchProvider     (NEW)               │
│            └─► YouComSearchProvider     (NEW)               │
└─────────────────────────────────────────────────────────────┘
```

---

## New Files to Create

```
src/
├── storage/
│   ├── index.ts              # Storage factory + interface
│   ├── redis.ts              # Redis implementation
│   └── file.ts               # File-based fallback
├── providers/
│   └── search/
│       ├── jina_search/
│       │   └── index.ts      # Jina Search API (s.jina.ai)
│       ├── serper/
│       │   └── index.ts      # Serper API (Google results)
│       └── youcom/
│           └── index.ts      # You.com API
├── routing/
│   └── budget_router.ts      # Core routing logic
└── tools/
    └── check_search_budget.ts  # New MCP tool
```

## Files to Modify

```
src/
├── config/
│   └── env.ts                # Add new API keys + REDIS_URL
├── providers/
│   ├── index.ts              # Register new providers
│   └── unified/
│       └── web_search.ts     # Integrate BudgetRouter
└── index.ts                  # Register check_search_budget tool
```

---

## Implementation Details

### 1. Storage Layer (`src/storage/`)

#### Interface (`index.ts`)

```typescript
export interface UsageStorage {
  /**
   * Get current count for a key. Returns 0 if key doesn't exist.
   */
  get(key: string): Promise<number>;
  
  /**
   * Increment count for a key. Returns new value.
   */
  increment(key: string): Promise<number>;
  
  /**
   * Get all usage data (for check_search_budget tool)
   */
  getAll(): Promise<Record<string, number>>;
}

/**
 * Factory function - uses Redis if REDIS_URL is set, otherwise file storage
 */
export function createStorage(): UsageStorage {
  if (process.env.REDIS_URL) {
    return new RedisStorage(process.env.REDIS_URL);
  }
  return new FileStorage();
}
```

#### File Storage (`file.ts`)

**Location:** `~/.mcp-omnisearch/usage.json` (use `os.homedir()`)

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export class FileStorage implements UsageStorage {
  private filePath: string;
  
  constructor() {
    const dir = path.join(os.homedir(), '.mcp-omnisearch');
    this.filePath = path.join(dir, 'usage.json');
  }
  
  async get(key: string): Promise<number> {
    const data = await this.load();
    return data[key] ?? 0;
  }
  
  async increment(key: string): Promise<number> {
    const data = await this.load();
    data[key] = (data[key] ?? 0) + 1;
    await this.save(data);
    return data[key];
  }
  
  async getAll(): Promise<Record<string, number>> {
    return this.load();
  }
  
  private async load(): Promise<Record<string, number>> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {}; // File doesn't exist yet
    }
  }
  
  private async save(data: Record<string, number>): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
```

#### Redis Storage (`redis.ts`)

```typescript
import { createClient, RedisClientType } from 'redis';

export class RedisStorage implements UsageStorage {
  private client: RedisClientType;
  private connected: boolean = false;
  
  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on('error', (err) => console.error('Redis error:', err));
  }
  
  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }
  
  async get(key: string): Promise<number> {
    await this.ensureConnected();
    const value = await this.client.get(`omnisearch:${key}`);
    return value ? parseInt(value, 10) : 0;
  }
  
  async increment(key: string): Promise<number> {
    await this.ensureConnected();
    return this.client.incr(`omnisearch:${key}`);
  }
  
  async getAll(): Promise<Record<string, number>> {
    await this.ensureConnected();
    const keys = await this.client.keys('omnisearch:*');
    const result: Record<string, number> = {};
    for (const key of keys) {
      const value = await this.client.get(key);
      const shortKey = key.replace('omnisearch:', '');
      result[shortKey] = value ? parseInt(value, 10) : 0;
    }
    return result;
  }
}
```

**Note:** Add `redis` to package.json dependencies.

---

### 2. Provider Limits Configuration

Add to `src/config/env.ts`:

```typescript
export const PROVIDER_LIMITS = {
  brave: { limit: 2000, type: 'monthly' as const },
  tavily: { limit: 1000, type: 'monthly' as const },
  exa: { limit: 2000, type: 'lifetime' as const },
  jina_search: { limit: 1000, type: 'lifetime' as const },
  serper: { limit: 2500, type: 'lifetime' as const },
  youcom: { limit: 16000, type: 'lifetime' as const },
} as const;

// New API keys
export const config = {
  // ... existing config ...
  search: {
    // ... existing ...
    jina_search: {
      api_key: process.env.JINA_API_KEY || process.env.JINA_AI_API_KEY,
      timeout: 30000,
    },
    serper: {
      api_key: process.env.SERPER_API_KEY,
      timeout: 30000,
    },
    youcom: {
      api_key: process.env.YOU_API_KEY,
      timeout: 30000,
    },
  },
  storage: {
    redis_url: process.env.REDIS_URL,
  },
};
```

---

### 3. Budget Router (`src/routing/budget_router.ts`)

```typescript
import { UsageStorage, createStorage } from '../storage/index.js';
import { PROVIDER_LIMITS } from '../config/env.js';
import { SearchProvider, SearchResult, BaseSearchParams } from '../common/types.js';

type ProviderName = keyof typeof PROVIDER_LIMITS;

interface RouteOptions {
  query: string;
  preferGoogle?: boolean;
  includeContent?: boolean;
  quality?: 'budget' | 'high';
}

export class BudgetRouter {
  private storage: UsageStorage;
  private providers: Map<ProviderName, SearchProvider>;
  
  // Default priority order
  private defaultStack: ProviderName[] = [
    'brave', 'tavily', 'exa', 'jina_search', 'serper', 'youcom'
  ];
  
  // Google-preferred order (Serper before Jina)
  private googleStack: ProviderName[] = [
    'brave', 'tavily', 'exa', 'serper', 'jina_search', 'youcom'
  ];
  
  constructor(providers: Map<ProviderName, SearchProvider>) {
    this.storage = createStorage();
    this.providers = providers;
  }
  
  /**
   * Generate the storage key for a provider
   * Monthly providers: "brave:2026-02"
   * Lifetime providers: "exa:lifetime"
   */
  private getStorageKey(provider: ProviderName): string {
    const config = PROVIDER_LIMITS[provider];
    if (config.type === 'monthly') {
      const month = new Date().toISOString().slice(0, 7); // "2026-02"
      return `${provider}:${month}`;
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
   * Record a successful search
   */
  private async recordUsage(provider: ProviderName, paid: boolean = false): Promise<void> {
    const key = this.getStorageKey(provider);
    await this.storage.increment(key);
    
    if (paid) {
      await this.storage.increment(`${provider}:paid`);
    }
  }
  
  /**
   * Route a search request to the best available provider
   */
  async route(options: RouteOptions): Promise<{ results: SearchResult[]; provider: string }> {
    const stack = options.preferGoogle ? this.googleStack : this.defaultStack;
    
    // Special case: include_content always uses Jina Search
    if (options.includeContent) {
      return this.executeSearch('jina_search', options.query, { includeContent: true });
    }
    
    // Try each provider in order
    for (const providerName of stack) {
      const provider = this.providers.get(providerName);
      if (!provider) continue; // Provider not configured (no API key)
      
      const hasQuota = await this.hasQuota(providerName);
      
      if (hasQuota) {
        // Use free tier
        const result = await this.executeSearch(providerName, options.query);
        await this.recordUsage(providerName, false);
        return result;
      }
    }
    
    // All free tiers exhausted - use paid fallback (Jina Search is cheapest)
    const paidProvider = options.preferGoogle ? 'serper' : 'jina_search';
    const result = await this.executeSearch(paidProvider, options.query);
    await this.recordUsage(paidProvider, true);
    return result;
  }
  
  private async executeSearch(
    providerName: ProviderName, 
    query: string,
    options?: { includeContent?: boolean }
  ): Promise<{ results: SearchResult[]; provider: string }> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} not available`);
    }
    
    const results = await provider.search({ query, ...options });
    return { results, provider: providerName };
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
      paid: {},
    };
    
    for (const [provider, config] of Object.entries(PROVIDER_LIMITS)) {
      if (config.type === 'monthly') {
        const key = `${provider}:${currentMonth}`;
        const used = allUsage[key] ?? 0;
        stats.monthly[provider] = {
          used,
          limit: config.limit,
          remaining: Math.max(0, config.limit - used),
        };
      } else {
        const key = `${provider}:lifetime`;
        const used = allUsage[key] ?? 0;
        stats.lifetime[provider] = {
          used,
          limit: config.limit,
          remaining: Math.max(0, config.limit - used),
        };
      }
      
      // Paid usage
      const paidKey = `${provider}:paid`;
      stats.paid[provider] = allUsage[paidKey] ?? 0;
    }
    
    return stats;
  }
}

export interface BudgetStats {
  monthly: Record<string, { used: number; limit: number; remaining: number }>;
  lifetime: Record<string, { used: number; limit: number; remaining: number }>;
  paid: Record<string, number>;
}
```

---

### 4. New Search Providers

#### Jina Search (`src/providers/search/jina_search/index.ts`)

**API Endpoint:** `https://s.jina.ai/{query}`

**Documentation:** https://jina.ai/reader

```typescript
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
  retry_with_backoff,
  validate_api_key,
} from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface JinaSearchParams extends BaseSearchParams {
  includeContent?: boolean;
}

interface JinaSearchResult {
  title: string;
  url: string;
  description: string;
  content?: string;  // Full page content when available
}

export class JinaSearchProvider implements SearchProvider {
  name = 'jina_search';
  description = 'Search the web using Jina Search API. Returns results with optional full page content.';

  async search(params: JinaSearchParams): Promise<SearchResult[]> {
    const api_key = validate_api_key(
      config.search.jina_search.api_key,
      this.name
    );

    const search_request = async () => {
      // Jina Search uses a simple GET request with query in URL
      const encoded_query = encodeURIComponent(params.query);
      const url = `https://s.jina.ai/${encoded_query}`;
      
      const response = await http_json<JinaSearchResult[]>(
        this.name,
        url,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${api_key}`,
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(config.search.jina_search.timeout),
        }
      );

      if (!Array.isArray(response)) {
        throw new ProviderError(
          ErrorType.API_ERROR,
          'Invalid response format from Jina Search',
          this.name
        );
      }

      return response.map((result, index) => ({
        title: result.title || '',
        url: result.url || '',
        snippet: result.description || '',
        content: result.content,  // Full content if available
        position: index + 1,
        source_provider: this.name,
      }));
    };

    try {
      return await retry_with_backoff(search_request);
    } catch (error: unknown) {
      handle_provider_error(error, this.name, 'search');
    }
  }
}
```

#### Serper (`src/providers/search/serper/index.ts`)

**API Endpoint:** `https://google.serper.dev/search`

**Documentation:** https://serper.dev/docs

```typescript
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
  retry_with_backoff,
  validate_api_key,
} from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface SerperResponse {
  organic: Array<{
    title: string;
    link: string;
    snippet: string;
    position: number;
  }>;
}

export class SerperSearchProvider implements SearchProvider {
  name = 'serper';
  description = 'Search Google using Serper API. Returns Google search results.';

  async search(params: BaseSearchParams): Promise<SearchResult[]> {
    const api_key = validate_api_key(
      config.search.serper.api_key,
      this.name
    );

    const search_request = async () => {
      const response = await http_json<SerperResponse>(
        this.name,
        'https://google.serper.dev/search',
        {
          method: 'POST',
          headers: {
            'X-API-KEY': api_key,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            q: params.query,
            num: params.limit || 10,
          }),
          signal: AbortSignal.timeout(config.search.serper.timeout),
        }
      );

      if (!response?.organic) {
        throw new ProviderError(
          ErrorType.API_ERROR,
          'Invalid response format from Serper',
          this.name
        );
      }

      return response.organic.map((result) => ({
        title: result.title || '',
        url: result.link || '',
        snippet: result.snippet || '',
        position: result.position,
        source_provider: this.name,
      }));
    };

    try {
      return await retry_with_backoff(search_request);
    } catch (error: unknown) {
      handle_provider_error(error, this.name, 'search');
    }
  }
}
```

#### You.com (`src/providers/search/youcom/index.ts`)

**API Endpoint:** `https://api.ydc-index.io/search`

**Documentation:** https://documentation.you.com/api-reference/search

```typescript
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
  retry_with_backoff,
  validate_api_key,
} from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface YouComResponse {
  hits: Array<{
    title: string;
    url: string;
    description: string;
  }>;
}

export class YouComSearchProvider implements SearchProvider {
  name = 'youcom';
  description = 'Search using You.com API.';

  async search(params: BaseSearchParams): Promise<SearchResult[]> {
    const api_key = validate_api_key(
      config.search.youcom.api_key,
      this.name
    );

    const search_request = async () => {
      const url = new URL('https://api.ydc-index.io/search');
      url.searchParams.set('query', params.query);
      
      const response = await http_json<YouComResponse>(
        this.name,
        url.toString(),
        {
          method: 'GET',
          headers: {
            'X-API-Key': api_key,
          },
          signal: AbortSignal.timeout(config.search.youcom.timeout),
        }
      );

      if (!response?.hits) {
        throw new ProviderError(
          ErrorType.API_ERROR,
          'Invalid response format from You.com',
          this.name
        );
      }

      return response.hits.map((result, index) => ({
        title: result.title || '',
        url: result.url || '',
        snippet: result.description || '',
        position: index + 1,
        source_provider: this.name,
      }));
    };

    try {
      return await retry_with_backoff(search_request);
    } catch (error: unknown) {
      handle_provider_error(error, this.name, 'search');
    }
  }
}
```

---

### 5. Check Search Budget Tool (`src/tools/check_search_budget.ts`)

```typescript
import { BudgetRouter, BudgetStats } from '../routing/budget_router.js';

export function formatBudgetStats(stats: BudgetStats): string {
  const lines: string[] = ['# Search Budget Status\n'];
  
  // Monthly providers
  lines.push('## Monthly (resets on 1st)');
  for (const [provider, data] of Object.entries(stats.monthly)) {
    const pct = Math.round((data.used / data.limit) * 100);
    const bar = getProgressBar(pct);
    lines.push(`- **${provider}**: ${data.used}/${data.limit} (${data.remaining} remaining) ${bar}`);
  }
  
  // Lifetime providers
  lines.push('\n## One-Time Credits');
  for (const [provider, data] of Object.entries(stats.lifetime)) {
    const pct = Math.round((data.used / data.limit) * 100);
    const bar = getProgressBar(pct);
    lines.push(`- **${provider}**: ${data.used}/${data.limit} (${data.remaining} remaining) ${bar}`);
  }
  
  // Paid usage
  const paidTotal = Object.values(stats.paid).reduce((a, b) => a + b, 0);
  if (paidTotal > 0) {
    lines.push('\n## Paid Usage');
    for (const [provider, count] of Object.entries(stats.paid)) {
      if (count > 0) {
        lines.push(`- **${provider}**: ${count} searches`);
      }
    }
  }
  
  return lines.join('\n');
}

function getProgressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}
```

Register as MCP tool in `src/index.ts`:

```typescript
{
  name: 'check_search_budget',
  description: 'Check remaining search budget across all providers. Shows free tier usage and paid consumption.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const stats = await budgetRouter.getUsageStats();
    return formatBudgetStats(stats);
  },
}
```

---

### 6. Update web_search Tool

Modify `src/providers/unified/web_search.ts` to use BudgetRouter:

```typescript
// New parameters for web_search
export interface UnifiedWebSearchParams extends BaseSearchParams {
  provider?: WebSearchProvider;  // Optional now - router picks if not specified
  quality?: 'budget' | 'high';
  include_content?: boolean;
}

// In the search method:
async search(params: UnifiedWebSearchParams): Promise<SearchResult[]> {
  // Quality mode bypasses budget routing
  if (params.quality === 'high') {
    // Route to Perplexity Sonar via ai_search
    return this.perplexityProvider.search(params);
  }
  
  // If specific provider requested, use it directly (existing behavior)
  if (params.provider) {
    const selectedProvider = this.providers.get(params.provider);
    if (!selectedProvider) {
      throw new ProviderError(
        ErrorType.INVALID_INPUT,
        `Invalid provider: ${params.provider}`,
        this.name
      );
    }
    return selectedProvider.search(params);
  }
  
  // Budget-aware routing
  const preferGoogle = params.query.toLowerCase().includes('google');
  const { results, provider } = await this.budgetRouter.route({
    query: params.query,
    preferGoogle,
    includeContent: params.include_content,
  });
  
  return results;
}
```

---

## Environment Variables

Add to `.env.example` and documentation:

```bash
# Existing
BRAVE_API_KEY=your-brave-key
TAVILY_API_KEY=your-tavily-key
EXA_API_KEY=your-exa-key
JINA_AI_API_KEY=your-jina-key  # Used for jina_reader, jina_grounding, AND jina_search

# New
SERPER_API_KEY=your-serper-key
YOU_API_KEY=your-youcom-key

# Optional - uses file storage if not set
REDIS_URL=redis://localhost:6379
```

---

## Testing Checklist

### Unit Tests

- [ ] FileStorage: get, increment, getAll
- [ ] RedisStorage: get, increment, getAll
- [ ] BudgetRouter: routing logic, quota checking
- [ ] Each new provider: API calls, error handling

### Integration Tests

- [ ] Full routing flow: exhaust Brave → failover to Tavily
- [ ] Monthly key rotation: simulate month change
- [ ] Paid fallback: all free tiers exhausted
- [ ] Google-specific routing: query contains "google"
- [ ] include_content mode: direct to Jina Search

### Manual Testing

```bash
# Check budget
mcp call check_search_budget

# Normal search (budget routing)
mcp call web_search '{"query": "AI news"}'

# Google-specific
mcp call web_search '{"query": "google AI news"}'

# With content
mcp call web_search '{"query": "AI news", "include_content": true}'

# High quality
mcp call web_search '{"query": "explain quantum computing", "quality": "high"}'
```

---

## Documentation Updates

After implementation, update these files:

1. **README.md** - Add budget routing section:
   - New environment variables
   - How routing works
   - `check_search_budget` tool

2. **CONTRIBUTING.md** - Provider implementation pattern for new search providers

3. **Clawdbot docs** - Integration guide for Redis configuration

---

## Implementation Order

1. **Storage layer** - `src/storage/` (interface, file, redis)
2. **Config updates** - `src/config/env.ts` (limits, new API keys)
3. **Jina Search provider** - `src/providers/search/jina_search/`
4. **Serper provider** - `src/providers/search/serper/`
5. **You.com provider** - `src/providers/search/youcom/`
6. **Budget router** - `src/routing/budget_router.ts`
7. **check_search_budget tool** - `src/tools/`
8. **Integrate into web_search** - `src/providers/unified/web_search.ts`
9. **Tests**
10. **Documentation**

---

## API Reference Quick Links

| Provider | Docs | Dashboard |
|----------|------|-----------|
| Jina Search | https://jina.ai/reader | https://jina.ai/api-dashboard |
| Serper | https://serper.dev/docs | https://serper.dev/dashboard |
| You.com | https://documentation.you.com | https://you.com/api |

---

## Cost Summary

| Provider | Free | Paid |
|----------|------|------|
| Brave | 2K/mo | — |
| Tavily | 1K/mo | — |
| Exa | ~2K total | — |
| Jina Search | 1K total | $0.50/1K |
| Serper | 2.5K total | $1.00/1K |
| You.com | ~16K total | Hard stop |

**Total free runway:** ~24,500 searches (3K monthly + 21.5K one-time)
