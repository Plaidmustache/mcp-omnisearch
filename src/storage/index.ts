/**
 * Usage storage interface and factory for budget tracking
 */

import { FileStorage } from './file.js';
import { RedisStorage } from './redis.js';

/**
 * Interface for usage storage implementations
 */
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

export { FileStorage } from './file.js';
export { RedisStorage } from './redis.js';
