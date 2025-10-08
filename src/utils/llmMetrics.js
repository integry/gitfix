import Redis from 'ioredis';
import logger from './logger.js';

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
 * Records LLM metrics for a completed Claude execution
 * @param {Object} claudeResult - Result from Claude execution
 * @param {Object} issueRef - Issue reference
 * @param {string} jobType - Type of job (issue or pr_comment)
 * @param {string} correlationId - Correlation ID for tracking
 */
export async function recordLLMMetrics(claudeResult, issueRef, jobType = 'issue', correlationId) {
    const metricsRedis = new Redis(connectionOptions);
    
    try {
        const timestamp = new Date().toISOString();
        const dateKey = timestamp.split('T')[0];
        
        // Extract core metrics
        const model = claudeResult?.model || process.env.CLAUDE_MODEL || 'unknown';
        const success = claudeResult?.success || false;
        const executionTimeMs = claudeResult?.executionTime || 0;
        const executionTimeSec = Math.round(executionTimeMs / 1000);
        const numTurns = claudeResult?.finalResult?.num_turns || 0;
        const costUsd = claudeResult?.finalResult?.cost_usd ||
                       claudeResult?.finalResult?.total_cost_usd || 0;
        const sessionId = claudeResult?.sessionId || 'unknown';
        const conversationId = claudeResult?.conversationId || null;
        
        // Store detailed LLM metrics
        const llmMetricsKey = `llm:metrics:${correlationId}`;
        const llmMetrics = {
            correlationId,
            timestamp,
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            jobType,
            model,
            success,
            executionTimeMs,
            executionTimeSec,
            numTurns,
            costUsd,
            sessionId,
            conversationId,
            error: claudeResult?.error || null,
            failureReason: !success ? (claudeResult?.error || 'unknown') : null
        };
        
        // Store with expiry of 30 days for analysis
        await metricsRedis.setex(llmMetricsKey, 30 * 24 * 3600, JSON.stringify(llmMetrics));
        
        // Update aggregated metrics
        if (success) {
            await metricsRedis.incr('llm:metrics:total:successful');
            await metricsRedis.incr(`llm:metrics:daily:${dateKey}:successful`);
            await metricsRedis.incr(`llm:metrics:model:${model}:successful`);
        } else {
            await metricsRedis.incr('llm:metrics:total:failed');
            await metricsRedis.incr(`llm:metrics:daily:${dateKey}:failed`);
            await metricsRedis.incr(`llm:metrics:model:${model}:failed`);
        }
        
        // Update cost metrics
        const currentTotalCost = parseFloat(await metricsRedis.get('llm:metrics:total:costUsd') || '0');
        await metricsRedis.set('llm:metrics:total:costUsd', (currentTotalCost + costUsd).toFixed(4));
        
        const currentDailyCost = parseFloat(await metricsRedis.get(`llm:metrics:daily:${dateKey}:costUsd`) || '0');
        await metricsRedis.set(`llm:metrics:daily:${dateKey}:costUsd`, (currentDailyCost + costUsd).toFixed(4));
        
        const currentModelCost = parseFloat(await metricsRedis.get(`llm:metrics:model:${model}:costUsd`) || '0');
        await metricsRedis.set(`llm:metrics:model:${model}:costUsd`, (currentModelCost + costUsd).toFixed(4));
        
        // Update turns metrics
        const currentTotalTurns = parseInt(await metricsRedis.get('llm:metrics:total:turns') || '0');
        await metricsRedis.set('llm:metrics:total:turns', currentTotalTurns + numTurns);
        
        const currentModelTurns = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:turns`) || '0');
        await metricsRedis.set(`llm:metrics:model:${model}:turns`, currentModelTurns + numTurns);
        
        // Update execution time metrics
        const currentTotalTime = parseInt(await metricsRedis.get('llm:metrics:total:executionTimeMs') || '0');
        await metricsRedis.set('llm:metrics:total:executionTimeMs', currentTotalTime + executionTimeMs);
        
        const currentModelTime = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:executionTimeMs`) || '0');
        await metricsRedis.set(`llm:metrics:model:${model}:executionTimeMs`, currentModelTime + executionTimeMs);
        
        // Track model usage
        await metricsRedis.sadd('llm:metrics:models:used', model);
        
        // Store in time series for analysis (last 1000 entries)
        const timeSeriesEntry = {
            timestamp,
            correlationId,
            model,
            success,
            costUsd,
            executionTimeSec,
            numTurns,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`
        };
        await metricsRedis.lpush('llm:metrics:timeseries', JSON.stringify(timeSeriesEntry));
        await metricsRedis.ltrim('llm:metrics:timeseries', 0, 999);
        
        // Store cost alert if exceeds threshold
        const costThreshold = parseFloat(process.env.LLM_COST_THRESHOLD_USD || '10.00');
        if (costUsd > costThreshold) {
            const alertEntry = {
                timestamp,
                correlationId,
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                costUsd,
                threshold: costThreshold,
                model,
                numTurns
            };
            await metricsRedis.lpush('llm:metrics:alerts:highcost', JSON.stringify(alertEntry));
            await metricsRedis.ltrim('llm:metrics:alerts:highcost', 0, 99);
            
            logger.warn({
                ...alertEntry,
                message: 'LLM cost exceeded threshold'
            });
        }
        
        logger.info({
            correlationId,
            issueNumber: issueRef.number,
            model,
            success,
            costUsd,
            executionTimeSec,
            numTurns
        }, 'LLM metrics recorded');
        
    } catch (error) {
        logger.error({
            error: error.message,
            stack: error.stack,
            correlationId
        }, 'Failed to record LLM metrics');
    } finally {
        await metricsRedis.quit();
    }
}

/**
 * Retrieves LLM metrics summary
 * @returns {Promise<Object>} LLM metrics summary
 */
export async function getLLMMetricsSummary() {
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
        logger.error({
            error: error.message,
            stack: error.stack
        }, 'Failed to retrieve LLM metrics summary');
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
export async function getLLMMetricsByCorrelationId(correlationId) {
    const metricsRedis = new Redis(connectionOptions);
    
    try {
        const metricsKey = `llm:metrics:${correlationId}`;
        const metricsData = await metricsRedis.get(metricsKey);
        
        if (metricsData) {
            return JSON.parse(metricsData);
        }
        
        return null;
    } catch (error) {
        logger.error({
            error: error.message,
            correlationId
        }, 'Failed to retrieve LLM metrics by correlation ID');
        return null;
    } finally {
        await metricsRedis.quit();
    }
}