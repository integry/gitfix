import { mock } from 'node:test';

// Mock implementation for recordLLMMetrics
export const mockRecordLLMMetrics = mock.fn(async () => {
    // No-op mock implementation
});

// Export a mock module object that can be used in tests
export const llmMetricsMock = {
    recordLLMMetrics: mockRecordLLMMetrics,
    getLLMMetricsSummary: mock.fn(async () => ({
        summary: {
            totalRequests: 0,
            totalSuccessful: 0,
            totalFailed: 0,
            successRate: 0,
            totalCostUsd: 0,
            avgCostPerRequest: 0,
            totalTurns: 0,
            avgTurnsPerRequest: 0,
            avgExecutionTimeSec: 0
        },
        modelBreakdown: {},
        dailyMetrics: [],
        recentHighCostAlerts: [],
        lastUpdated: new Date().toISOString()
    })),
    getLLMMetricsByCorrelationId: mock.fn(async () => null)
};