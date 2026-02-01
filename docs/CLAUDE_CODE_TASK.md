# Claude Code Implementation Prompt: mcp-omnisearch Budget-Aware Routing

## Mission

Implement budget-aware search routing for mcp-omnisearch. This feature automatically routes search requests through a prioritized stack of providers, maximizing free tier usage before falling back to paid options.

## Critical Context

**Repository:** `/Users/malone/Projects/mcp-omnisearch`
**Branch:** `feature/budget-aware-routing` (already created, no code changes yet)
**Implementation Plan:** `docs/BUDGET_ROUTING_IMPLEMENTATION_PLAN.md` (READ THIS FIRST)

## Execution Strategy

Use the **Task tool** to parallelize independent work. This implementation has natural parallelization points.

### Phase 1: Exploration (Parallel)

Before writing any code, launch **4 parallel Explore agents** to understand the codebase:

```
TASK 1 (Explore): Analyze src/config/env.ts
- How are existing API keys structured?
- What's the config export pattern?
- Find where JINA_AI_API_KEY is already defined

TASK 2 (Explore): Analyze src/providers/search/ directory  
- Study an existing provider (e.g., brave/, tavily/, exa/)
- Document the provider interface pattern
- Note imports, error handling, retry logic

TASK 3 (Explore): Analyze src/providers/unified/web_search.ts
- How does the current unified search work?
- How are providers registered and selected?
- Where should BudgetRouter integrate?

TASK 4 (Explore): Analyze src/common/types.ts and src/common/utils.ts
- Document SearchProvider interface
- Document SearchResult type
- Find handle_provider_error, retry_with_backoff, validate_api_key
```

**Wait for all 4 tasks to complete before proceeding.**

### Phase 2: Foundation (Sequential)

Build the storage layer first - everything else depends on it.

```
TASK 5: Create src/storage/index.ts
- UsageStorage interface (get, increment, getAll)
- createStorage() factory function
- See implementation plan for exact code

TASK 6: Create src/storage/file.ts (after Task 5)
- FileStorage class implementing UsageStorage
- Location: ~/.mcp-omnisearch/usage.json
- Handle missing file gracefully

TASK 7: Create src/storage/redis.ts (after Task 5)
- RedisStorage class implementing UsageStorage
- Lazy connection pattern
- Prefix keys with "omnisearch:"
```

### Phase 3: Config Update (Sequential)

```
TASK 8: Update src/config/env.ts (after Tasks 5-7)
- Add PROVIDER_LIMITS configuration object
- Add jina_search, serper, youcom config sections
- Add storage.redis_url config
- Preserve all existing config
```

### Phase 4: New Providers (Parallel)

These 3 providers are independent - run in parallel:

```
TASK 9 (Background): Create src/providers/search/jina_search/index.ts
- Follow existing provider patterns from Task 2
- API: https://s.jina.ai/{query}
- Auth header: Bearer token
- Returns array with title, url, description, content

TASK 10 (Background): Create src/providers/search/serper/index.ts  
- API: POST https://google.serper.dev/search
- Auth header: X-API-KEY
- Response has organic[] array

TASK 11 (Background): Create src/providers/search/youcom/index.ts
- API: GET https://api.ydc-index.io/search?query=
- Auth header: X-API-Key
- Response has hits[] array
```

**Wait for Tasks 9-11 to complete.**

### Phase 5: Core Router (Sequential)

```
TASK 12: Create src/routing/budget_router.ts (after Tasks 8-11)
- BudgetRouter class
- getStorageKey() for monthly vs lifetime providers
- hasQuota() checks remaining budget
- route() implements the priority stack
- getUsageStats() for budget tool
- See implementation plan for full logic
```

### Phase 6: Integration (Sequential)

```
TASK 13: Create src/tools/check_search_budget.ts (after Task 12)
- formatBudgetStats() function
- Progress bar visualization
- Monthly, lifetime, and paid sections

TASK 14: Update src/providers/index.ts (after Tasks 9-11)
- Register JinaSearchProvider
- Register SerperSearchProvider  
- Register YouComSearchProvider

TASK 15: Update src/providers/unified/web_search.ts (after Task 12)
- Import BudgetRouter
- Add quality and include_content params
- Route through BudgetRouter when no provider specified
- Preserve existing explicit provider behavior

TASK 16: Update src/index.ts (after Task 13)
- Register check_search_budget tool
- Wire up handler to budgetRouter.getUsageStats()
```

### Phase 7: Dependencies & Verification (Sequential)

```
TASK 17: Update package.json
- Add "redis" dependency
- Run npm install

TASK 18: Build and type-check
- Run npm run build
- Fix any TypeScript errors
- Ensure clean compilation

TASK 19: Create basic test
- Test FileStorage manually
- Test that providers instantiate
- Verify check_search_budget returns formatted output
```

## Task Dependency Graph

```
Phase 1 (Parallel):     [T1] [T2] [T3] [T4]
                            ↓
Phase 2 (Sequential):      [T5] → [T6]
                            ↓      ↓
                           [T7] ←─┘
                            ↓
Phase 3:                   [T8]
                            ↓
Phase 4 (Parallel):    [T9] [T10] [T11]
                            ↓
Phase 5:                  [T12]
                            ↓
Phase 6 (Parallel):   [T13] [T14] [T15] [T16]
                            ↓
Phase 7 (Sequential): [T17] → [T18] → [T19]
```

## Implementation Principles

1. **Match existing patterns** - Study how brave/, tavily/, exa/ providers are structured and follow the same conventions exactly

2. **Preserve backward compatibility** - Explicit `provider: "brave"` requests must still work; budget routing only applies when no provider is specified

3. **Fail gracefully** - If Redis is unavailable, fall back to file storage. If a provider fails, try the next one in the stack.

4. **Type safety** - Full TypeScript types for all new code. No `any` types.

5. **Minimal changes to existing code** - Integration points should be surgical. Don't refactor unrelated code.

## API Reference

| Provider | Endpoint | Auth Header | Response Shape |
|----------|----------|-------------|----------------|
| Jina Search | `https://s.jina.ai/{query}` | `Authorization: Bearer {key}` | `[{title, url, description, content}]` |
| Serper | `POST https://google.serper.dev/search` | `X-API-KEY: {key}` | `{organic: [{title, link, snippet, position}]}` |
| You.com | `https://api.ydc-index.io/search?query=` | `X-API-Key: {key}` | `{hits: [{title, url, description}]}` |

## Environment Variables (for testing)

```bash
# Existing (already configured)
BRAVE_API_KEY=...
TAVILY_API_KEY=...
EXA_API_KEY=...
JINA_AI_API_KEY=...  # Already exists, reuse for jina_search

# New (need to add)
SERPER_API_KEY=...
YOU_API_KEY=...

# Optional
REDIS_URL=redis://localhost:6379
```

## Success Criteria

1. ✅ `npm run build` completes without errors
2. ✅ New providers appear in provider list
3. ✅ `check_search_budget` tool returns formatted budget status
4. ✅ Search without explicit provider uses budget routing
5. ✅ Search with explicit provider bypasses budget routing
6. ✅ File-based storage works when REDIS_URL is not set
7. ✅ Monthly counters use date-keyed storage (e.g., `brave:2026-02`)

## Getting Started

```bash
cd /Users/malone/Projects/mcp-omnisearch
git checkout feature/budget-aware-routing
cat docs/BUDGET_ROUTING_IMPLEMENTATION_PLAN.md  # Read the full plan
```

Then begin Phase 1 exploration tasks in parallel.

---

## Quick Reference: Routing Logic

```
DEFAULT:
  Brave → Tavily → Exa → Jina Search → Serper → You.com → STOP

IF query contains "google" OR options.provider = "google":
  Brave → Tavily → Exa → Serper → Jina Search → You.com → STOP

IF options.include_content = true:
  → Jina Search directly (bypasses budget stack)

IF all free tiers exhausted:
  → Jina Search paid ($0.50/1K) or Serper paid ($1/1K) for Google queries
```

## Quick Reference: Provider Limits

| Provider | Free Tier | Type | Paid Rate |
|----------|-----------|------|-----------|
| Brave | 2,000/month | Monthly | — |
| Tavily | 1,000/month | Monthly | — |
| Exa | ~2,000 | Lifetime | — |
| Jina Search | 1,000 | Lifetime | $0.50/1K |
| Serper | 2,500 | Lifetime | $1.00/1K |
| You.com | ~16,000 | Lifetime | Hard stop |
