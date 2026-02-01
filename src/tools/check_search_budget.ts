/**
 * Check Search Budget Tool
 * Displays current usage stats across all search providers
 */

import type { BudgetStats } from '../routing/budget_router.js';

/**
 * Format budget stats as a readable markdown report
 */
export function formatBudgetStats(stats: BudgetStats): string {
	const lines: string[] = ['# Search Budget Status\n'];

	// Monthly providers (reset on 1st of month)
	lines.push('## Monthly Quotas (reset on 1st)');
	const monthlyEntries = Object.entries(stats.monthly);
	if (monthlyEntries.length > 0) {
		for (const [provider, data] of monthlyEntries) {
			const pct = Math.round((data.used / data.limit) * 100);
			const bar = getProgressBar(pct);
			const status = data.remaining === 0 ? ' **EXHAUSTED**' : '';
			lines.push(
				`- **${provider}**: ${data.used.toLocaleString()}/${data.limit.toLocaleString()} (${data.remaining.toLocaleString()} remaining) ${bar}${status}`,
			);
		}
	} else {
		lines.push('- No monthly providers configured');
	}

	// Lifetime providers (one-time credits)
	lines.push('\n## One-Time Credits');
	const lifetimeEntries = Object.entries(stats.lifetime);
	if (lifetimeEntries.length > 0) {
		for (const [provider, data] of lifetimeEntries) {
			const pct = Math.round((data.used / data.limit) * 100);
			const bar = getProgressBar(pct);
			const status = data.remaining === 0 ? ' **EXHAUSTED**' : '';
			lines.push(
				`- **${provider}**: ${data.used.toLocaleString()}/${data.limit.toLocaleString()} (${data.remaining.toLocaleString()} remaining) ${bar}${status}`,
			);
		}
	} else {
		lines.push('- No lifetime providers configured');
	}

	// Paid APIs (no free tier)
	const paidApiEntries = Object.entries(stats.paidApis || {});
	if (paidApiEntries.length > 0) {
		lines.push('\n## Paid APIs (no free tier)');
		for (const [provider, data] of paidApiEntries) {
			const costStr = data.estimatedCost > 0 
				? ` (~$${data.estimatedCost.toFixed(2)} spent)`
				: '';
			lines.push(
				`- **${provider}**: ${data.used} calls @ $${data.costPerQuery}/query${costStr}`,
			);
		}
	}

	// Provider health (circuit breaker status)
	const healthEntries = Object.entries(stats.health || {});
	const unhealthyProviders = healthEntries.filter(([_, h]) => h.status !== 'healthy');
	if (unhealthyProviders.length > 0) {
		lines.push('\n## ⚠️ Provider Health Issues');
		for (const [provider, health] of unhealthyProviders) {
			const statusIcon = health.status === 'down' ? '🔴' : '🟡';
			const cooldown = health.cooldownUntil
				? ` (retry after ${new Date(health.cooldownUntil).toLocaleTimeString()})`
				: '';
			lines.push(
				`- ${statusIcon} **${provider}**: ${health.status} (${health.failures} failures)${cooldown}`,
			);
		}
	}

	// Paid usage (providers that exceeded free tier)
	const paidTotal = Object.values(stats.paid).reduce((a, b) => a + b, 0);
	if (paidTotal > 0) {
		lines.push('\n## Paid Usage (beyond free tier)');
		for (const [provider, count] of Object.entries(stats.paid)) {
			if (count > 0) {
				lines.push(`- **${provider}**: ${count.toLocaleString()} searches`);
			}
		}
	}

	// Summary
	lines.push('\n## Summary');

	const totalMonthlyUsed = monthlyEntries.reduce(
		(sum, [_, data]) => sum + data.used,
		0,
	);
	const totalMonthlyLimit = monthlyEntries.reduce(
		(sum, [_, data]) => sum + data.limit,
		0,
	);
	const totalLifetimeUsed = lifetimeEntries.reduce(
		(sum, [_, data]) => sum + data.used,
		0,
	);
	const totalLifetimeLimit = lifetimeEntries.reduce(
		(sum, [_, data]) => sum + data.limit,
		0,
	);
	const totalPaidApiCost = paidApiEntries.reduce(
		(sum, [_, data]) => sum + data.estimatedCost,
		0,
	);

	if (totalMonthlyLimit > 0) {
		lines.push(
			`- Monthly: ${totalMonthlyUsed.toLocaleString()}/${totalMonthlyLimit.toLocaleString()} used this month`,
		);
	}
	if (totalLifetimeLimit > 0) {
		lines.push(
			`- Lifetime: ${totalLifetimeUsed.toLocaleString()}/${totalLifetimeLimit.toLocaleString()} used total`,
		);
	}
	if (totalPaidApiCost > 0) {
		lines.push(`- Paid API spend: ~$${totalPaidApiCost.toFixed(2)}`);
	}
	if (paidTotal > 0) {
		lines.push(`- Overage searches: ${paidTotal.toLocaleString()}`);
	}

	return lines.join('\n');
}

/**
 * Generate a visual progress bar
 */
function getProgressBar(pct: number): string {
	const filled = Math.round(pct / 10);
	const empty = 10 - filled;
	return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}
