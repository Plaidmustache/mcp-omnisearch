/**
 * Redis-based usage storage implementation
 * Prefixes all keys with "omnisearch:" for namespace isolation
 */

import { createClient, type RedisClientType } from 'redis';

import type { UsageStorage } from './index.js';

export class RedisStorage implements UsageStorage {
  private client: RedisClientType;
  private connected: boolean = false;
  private connectionPromise: Promise<void> | null = null;

  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on('error', (err) => console.error('[omnisearch] Redis error:', err));
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;

    // Use a shared connection promise to avoid race conditions
    if (!this.connectionPromise) {
      this.connectionPromise = (async () => {
        await this.client.connect();
        this.connected = true;
      })();
    }

    await this.connectionPromise;
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

  /**
   * Gracefully close Redis connection
   */
  async close(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
      this.connectionPromise = null;
    }
  }
}
