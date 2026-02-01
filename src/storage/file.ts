/**
 * File-based usage storage implementation
 * Stores usage data in ~/.mcp-omnisearch/usage.json
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import type { UsageStorage } from './index.js';

export class FileStorage implements UsageStorage {
  private filePath: string;
  private dirPath: string;

  constructor() {
    this.dirPath = path.join(os.homedir(), '.mcp-omnisearch');
    this.filePath = path.join(this.dirPath, 'usage.json');
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
      // File doesn't exist yet or is invalid - return empty object
      return {};
    }
  }

  private async save(data: Record<string, number>): Promise<void> {
    await fs.mkdir(this.dirPath, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
