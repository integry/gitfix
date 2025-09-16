const Redis = require('ioredis');

// Redis configuration
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const connectionOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
};

/**
 * Retrieves LLM metrics summary
 * @returns {Promise<Object>} LLM metrics summary
 */
async function getLLMMetricsSummary() {
    const metricsRedis = new Redis(connectionOptions);
    
    try {
        // Get total metrics
        const totalSuccessful = parseInt(await metricsRedis.get('llm:metrics:total:successful') || '0');
        const totalFailed = parseInt(await metricsRedis.get('llm:metrics:total:failed') || '0');
        const totalCostUsd = parseFloat(await metricsRedis.get('llm:metrics:total:costUsd') || '0');
        const totalTurns = parseInt(await metricsRedis.get('llm:metrics:total:turns') || '0');
        const totalExecutionTimeMs = parseInt(await metricsRedis.get('llm:metrics:total:executionTimeMs') || '0');
        
        const totalRequests = totalSuccessful + totalFailed;
        const successRate = totalRequests > 0 ? totalSuccessful / totalRequests : 0;
        const avgCostPerRequest = totalRequests > 0 ? totalCostUsd / totalRequests : 0;
        const avgTurnsPerRequest = totalRequests > 0 ? totalTurns / totalRequests : 0;
        const avgExecutionTimeSec = totalRequests > 0 ? (totalExecutionTimeMs / totalRequests) / 1000 : 0;
        
        // Get model-specific metrics
        const modelsUsed = await metricsRedis.sMembers('llm:metrics:models:used');
        const modelMetrics = {};
        
        for (const model of modelsUsed) {
            const modelSuccessful = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:successful`) || '0');
            const modelFailed = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:failed`) || '0');
            const modelCostUsd = parseFloat(await metricsRedis.get(`llm:metrics:model:${model}:costUsd`) || '0');
            const modelTurns = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:turns`) || '0');
            const modelExecutionTimeMs = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:executionTimeMs`) || '0');
            
            const modelTotal = modelSuccessful + modelFailed;
            
            modelMetrics[model] = {
                totalRequests: modelTotal,
                successful: modelSuccessful,
                failed: modelFailed,
                successRate: modelTotal > 0 ? modelSuccessful / modelTotal : 0,
                totalCostUsd: modelCostUsd,
                avgCostPerRequest: modelTotal > 0 ? modelCostUsd / modelTotal : 0,
                totalTurns: modelTurns,
                avgTurnsPerRequest: modelTotal > 0 ? modelTurns / modelTotal : 0,
                avgExecutionTimeSec: modelTotal > 0 ? (modelExecutionTimeMs / modelTotal) / 1000 : 0
            };
        }
        
        // Get daily metrics for the last 7 days
        const dailyMetrics = [];
        const today = new Date();
        for (let i = 0; i < 7; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateKey = date.toISOString().split('T')[0];
            
            const daySuccessful = parseInt(await metricsRedis.get(`llm:metrics:daily:${dateKey}:successful`) || '0');
            const dayFailed = parseInt(await metricsRedis.get(`llm:metrics:daily:${dateKey}:failed`) || '0');
            const dayCostUsd = parseFloat(await metricsRedis.get(`llm:metrics:daily:${dateKey}:costUsd`) || '0');
            
            dailyMetrics.push({
                date: dateKey,
                successful: daySuccessful,
                failed: dayFailed,
                total: daySuccessful + dayFailed,
                costUsd: dayCostUsd
            });
        }
        
        // Get recent high cost alerts
        const highCostAlerts = await metricsRedis.lRange('llm:metrics:alerts:highcost', 0, 9);
        const parsedAlerts = highCostAlerts.map(alert => {
            try {
                return JSON.parse(alert);
            } catch (e) {
                return null;
            }
        }).filter(Boolean);
        
        return {
            summary: {
                totalRequests,
                totalSuccessful,
                totalFailed,
                successRate,
                totalCostUsd,
                avgCostPerRequest,
                totalTurns,
                avgTurnsPerRequest,
                avgExecutionTimeSec
            },
            modelBreakdown: modelMetrics,
            dailyMetrics,
            recentHighCostAlerts: parsedAlerts,
            lastUpdated: new Date().toISOString()
        };
        
    } catch (error) {
        console.error('Failed to retrieve LLM metrics summary:', error);
        throw error;
    } finally {
        await metricsRedis.quit();
    }
}

/**
 * Retrieves detailed LLM metrics for a specific correlation ID
 * @param {string} correlationId - Correlation ID
 * @returns {Promise<Object|null>} Detailed LLM metrics or null
 */
async function getLLMMetricsByCorrelationId(correlationId) {
    const metricsRedis = new Redis(connectionOptions);
    
    try {
        const metricsKey = `llm:metrics:${correlationId}`;
        const metricsData = await metricsRedis.get(metricsKey);
        
        if (metricsData) {
            return JSON.parse(metricsData);
        }
        
        return null;
    } catch (error) {
        console.error('Failed to retrieve LLM metrics by correlation ID:', error);
        return null;
    } finally {
        await metricsRedis.quit();
    }
}

module.exports = {
    getLLMMetricsSummary,
    getLLMMetricsByCorrelationId
};