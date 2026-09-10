import React, { useState, useRef, useEffect, useId, useMemo } from 'react';
import { AgentConfig, chatWithAgents, ChatResult, ChatQuery } from '../../api/proprApi';
import { MODEL_INFO_MAP, AgentType } from '../../config/modelDefinitions';
import { ProviderLogo } from '../ui/ProviderLogo';
import { Bot, Check, Layers3, Search, Send, User, X } from 'lucide-react';
import type { SyntheticAgentConfig } from '@propr/shared';

type AgentVisualType = AgentType | 'synthetic';

interface ChatPanelProps {
  agents: AgentConfig[];
  syntheticAgents?: SyntheticAgentConfig[];
  selectedModels: AgentModelSelection[];
  onSelectedModelsChange: (selectedModels: AgentModelSelection[]) => void;
  disabled?: boolean;
}

export interface AgentModelSelection {
  agentId: string;
  modelId: string;
}

interface Message {
  role: 'user' | 'assistant';
  content?: string;
  results?: ChatResult[];
  timestamp: number;
}

// Represents an agent+model combination for selection
interface AgentModelOption {
  agentId: string;
  agentAlias: string;
  agentType: AgentVisualType;
  syntheticConfigId?: string;
  modelId: string;
  modelName: string;
}

const isSameAgentModel = (
  left: AgentModelSelection,
  right: AgentModelSelection
) => left.agentId === right.agentId && left.modelId === right.modelId;

const haveSameSelections = (
  left: AgentModelSelection[],
  right: AgentModelSelection[]
) => (
  left.length === right.length
  && left.every((selection, index) => isSameAgentModel(selection, right[index]))
);

const ChatPanel: React.FC<ChatPanelProps> = ({
  agents,
  syntheticAgents = [],
  selectedModels,
  onSelectedModelsChange,
  disabled = false
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectorRef = useRef<HTMLDivElement>(null);
  const modelOptionsId = useId();

  // Build list of all enabled agent+model combinations
  const agentModelOptions = useMemo(() => {
    const options: AgentModelOption[] = [];
    agents.filter(a => a.enabled).forEach(agent => {
      agent.supportedModels.forEach(modelId => {
        const modelInfo = MODEL_INFO_MAP[modelId];
        options.push({
          agentId: agent.id,
          agentAlias: agent.alias,
          agentType: agent.type as AgentType,
          modelId: modelId,
          modelName: modelInfo?.name || modelId
        });
      });
    });
    syntheticAgents.filter(pool => pool.enabled).forEach(pool => {
      pool.models.filter(model => model.enabled).forEach(model => {
        options.push({
          agentId: pool.id,
          syntheticConfigId: pool.id,
          agentAlias: pool.alias,
          agentType: 'synthetic',
          modelId: model.id,
          modelName: model.displayName || model.id,
        });
      });
    });
    return options;
  }, [agents, syntheticAgents]);

  const filteredModelOptions = useMemo(() => {
    const terms = modelSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return agentModelOptions;

    return agentModelOptions.filter(option => {
      const searchableText = `${option.agentAlias} ${option.modelName} ${option.modelId}`.toLocaleLowerCase();
      return terms.every(term => searchableText.includes(term));
    });
  }, [agentModelOptions, modelSearch]);

  const selectedModelOptions = useMemo(() => selectedModels
    .map(selection => agentModelOptions.find(option => isSameAgentModel(option, selection)))
    .filter((option): option is AgentModelOption => Boolean(option)), [agentModelOptions, selectedModels]);

  // Keep selections limited to combinations exposed by the Playground. If an
  // agent is disabled or removed, fall back to the first available option.
  useEffect(() => {
    const availableSelections = selectedModels.filter(selection =>
      agentModelOptions.some(option => isSameAgentModel(selection, option))
    );
    const nextSelections = availableSelections.length > 0
      ? availableSelections
      : agentModelOptions.length > 0
        ? [{
            agentId: agentModelOptions[0].agentId,
            modelId: agentModelOptions[0].modelId
          }]
        : [];

    if (!haveSameSelections(selectedModels, nextSelections)) {
      onSelectedModelsChange(nextSelections);
    }
  }, [agentModelOptions, onSelectedModelsChange, selectedModels]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const closeSelector = (event: PointerEvent) => {
      if (!selectorRef.current?.contains(event.target as Node)) {
        setIsSelectorOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeSelector);
    return () => document.removeEventListener('pointerdown', closeSelector);
  }, []);

  const handleSend = async () => {
    if (!input.trim() || selectedModels.length === 0 || disabled) return;

    const userMsg: Message = { role: 'user', content: input, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    setInput('');

    try {
      // Build Context (simplified string of past messages)
      const context = messages.map(m =>
        m.role === 'user' ? `User: ${m.content}` : `Assistant: (Previous response hidden)`
      ).join('\n');

      // Build queries with agent+model combinations
      const queries: ChatQuery[] = selectedModels.map(selection => {
        const option = agentModelOptions.find(candidate => isSameAgentModel(candidate, selection));
        return {
          agentId: selection.agentId,
          ...(option?.syntheticConfigId ? { syntheticConfigId: option.syntheticConfigId } : {}),
          model: selection.modelId,
        };
      });

      const { results } = await chatWithAgents(queries, userMsg.content!, context);

      const assistantMsg: Message = {
        role: 'assistant',
        results: results,
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      console.error(err);
      const errorMsg: Message = {
        role: 'assistant',
        results: [{
          agentId: 'error',
          agentAlias: 'System',
          model: 'N/A',
          error: (err as Error).message || 'Failed to get response',
          durationMs: 0
        }],
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleSelection = (option: AgentModelOption) => {
    const selection = { agentId: option.agentId, modelId: option.modelId };
    const isSelected = selectedModels.some(selected => isSameAgentModel(selected, selection));

    onSelectedModelsChange(
      isSelected
        ? selectedModels.filter(selected => !isSameAgentModel(selected, selection))
        : [...selectedModels, selection]
    );
  };

  const handleModelSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setIsSelectorOpen(false);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIsSelectorOpen(true);
      setActiveOptionIndex(current => {
        if (filteredModelOptions.length === 0) return 0;
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        return (current + direction + filteredModelOptions.length) % filteredModelOptions.length;
      });
      return;
    }

    if (event.key === 'Enter' && isSelectorOpen && filteredModelOptions.length > 0) {
      event.preventDefault();
      toggleSelection(filteredModelOptions[Math.min(activeOptionIndex, filteredModelOptions.length - 1)]);
      setModelSearch('');
      setActiveOptionIndex(0);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#F8FAFC]">
      {/* Search-first model selector */}
      <div className="relative z-10 flex-shrink-0 border-b border-slate-200 bg-white" ref={selectorRef}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="text"
            role="combobox"
            aria-label="Search and add models to compare"
            aria-controls={modelOptionsId}
            aria-expanded={isSelectorOpen}
            aria-autocomplete="list"
            autoComplete="off"
            value={modelSearch}
            onFocus={() => {
              setIsSelectorOpen(true);
              setActiveOptionIndex(0);
            }}
            onChange={event => {
              setModelSearch(event.target.value);
              setIsSelectorOpen(true);
              setActiveOptionIndex(0);
            }}
            onKeyDown={handleModelSearchKeyDown}
            placeholder={'Search and add models to compare (e.g., "Opus", "GPT-6")...'}
            className="w-full border-b border-slate-200 bg-white py-3 pl-11 pr-4 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-teal-500"
          />
        </div>

        <div className="flex min-h-10 items-center gap-2 px-4 py-2">
          <div className="scrollbar-stealth flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            {selectedModelOptions.length > 0 ? selectedModelOptions.map(option => (
              <button
                key={JSON.stringify([option.agentId, option.modelId])}
                type="button"
                onClick={() => toggleSelection(option)}
                aria-label={`${option.agentAlias}: ${option.modelName}`}
                aria-pressed="true"
                title={`Remove ${option.modelName}`}
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded border border-slate-200 bg-slate-100 px-2 py-1 font-mono text-[12px] text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
              >
                {option.syntheticConfigId
                  ? <Layers3 className="h-3 w-3" aria-hidden="true" />
                  : <ProviderLogo provider={option.agentAlias} className="h-3 w-3" />}
                <span>{option.modelName}</span>
                <X className="h-3 w-3 text-slate-400" aria-hidden="true" />
              </button>
            )) : (
              <span className={`whitespace-nowrap text-[11px] ${agentModelOptions.length > 0 ? 'text-amber-600' : 'text-slate-500'}`}>
                {agentModelOptions.length > 0 ? 'Select at least one model to start chatting' : 'No enabled models available.'}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setMessages([])}
            className="flex-shrink-0 rounded px-2 py-1 text-xs text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700"
            title="Clear History"
          >
            Clear
          </button>
        </div>

        {isSelectorOpen && (
          <div
            id={modelOptionsId}
            role="listbox"
            aria-label="Available models"
            aria-multiselectable="true"
            className="absolute left-3 right-3 top-[46px] z-20 max-h-72 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-xl scrollbar-stealth"
          >
            {filteredModelOptions.length > 0 ? filteredModelOptions.map((option, index) => {
              const selection = { agentId: option.agentId, modelId: option.modelId };
              const isSelected = selectedModels.some(selected => isSameAgentModel(selected, selection));
              return (
                <button
                  key={JSON.stringify([option.agentId, option.modelId])}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveOptionIndex(index)}
                  onClick={() => {
                    toggleSelection(option);
                    setModelSearch('');
                    setActiveOptionIndex(0);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                    index === activeOptionIndex ? 'bg-slate-100' : 'hover:bg-slate-50'
                  }`}
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    {option.syntheticConfigId
                      ? <Layers3 className="h-4 w-4 text-slate-500" aria-hidden="true" />
                      : <ProviderLogo provider={option.agentAlias} className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-slate-800">{option.modelName}</span>
                    <span className="block truncate font-mono text-[10px] text-slate-400">{option.agentAlias} · {option.modelId}</span>
                  </span>
                  {isSelected && <Check className="h-4 w-4 flex-shrink-0 text-teal-600" aria-hidden="true" />}
                </button>
              );
            }) : (
              <div className="px-3 py-6 text-center text-sm text-slate-500">
                No models match “{modelSearch.trim()}”.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Messages Area - Studio Assistant styling */}
      <div
        className="flex-1 overflow-y-auto px-4 pb-4 space-y-4"
        ref={scrollRef}
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: '#d1d5db transparent'
        }}
      >
        {messages.length === 0 && (
          <div className="px-2 py-4">
            <p className="text-sm text-gray-500">
              Test your agents by sending messages. Select one or more models above to compare responses side by side.
            </p>
          </div>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className="flex items-start">
            {msg.role === 'user' ? (
              <>
                {/* Fixed 40px icon column for gutter alignment */}
                <div className="w-10 flex-shrink-0 flex justify-center">
                  <div className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center">
                    <User size={16} className="text-slate-600" />
                  </div>
                </div>
                {/* User message - white card with shadow */}
                <div className="flex-1 min-w-0 ml-3">
                  <div className="bg-white border border-indigo-100 text-slate-800 shadow-sm px-4 py-2 rounded-lg inline-block">
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Fixed 40px icon column for gutter alignment */}
                <div className="w-10 flex-shrink-0 flex justify-center pt-1">
                  <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center">
                    <Bot size={16} className="text-white" />
                  </div>
                </div>
                {/* AI responses - transparent background, horizontal scroll for multiple */}
                <div className="flex-1 min-w-0 ml-3">
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {msg.results?.map((res, rIdx) => (
                      <div key={rIdx} className={`flex-1 min-w-[220px] max-w-[300px] bg-transparent relative flex flex-col ${rIdx > 0 ? 'border-l border-slate-200 pl-3' : ''}`}>
                        <div className="text-[10px] font-medium text-gray-500 mb-1 flex items-center gap-1.5">
                          {res.virtualAgentAlias
                            ? <Layers3 className="h-3 w-3" aria-hidden="true" />
                            : <ProviderLogo provider={res.agentAlias} className="w-3 h-3" />}
                          <span>{res.virtualAgentAlias || res.agentAlias}</span>
                          <span className="text-gray-400">· {res.virtualModel || res.model}</span>
                        </div>
                        {res.physicalAgentAlias && (
                          <div className="mb-1 flex items-center gap-1 text-[10px] text-slate-500">
                            <ProviderLogo provider={res.physicalAgentAlias} className="h-3 w-3" />
                            <span>Executed by {res.physicalAgentAlias} · {res.physicalModel}</span>
                            {res.attemptNumber && <span>· attempt {res.attemptNumber}</span>}
                          </div>
                        )}
                        <div className="text-sm text-gray-800 whitespace-pre-wrap">
                          {res.error ? <span className="text-red-500">{res.error}</span> : res.response}
                        </div>
                        <div className="text-[10px] text-gray-400 mt-1">
                          {res.durationMs}ms
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex items-start">
            <div className="w-10 flex-shrink-0 flex justify-center">
              <div className="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center">
                <Bot size={16} className="text-gray-600 animate-pulse" />
              </div>
            </div>
            <div className="flex-1 min-w-0 ml-3">
              <div className="bg-slate-200 text-gray-600 italic p-3 rounded-lg inline-block">
                <p className="text-sm animate-pulse">Thinking...</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating Input Bar - visually detached from bottom */}
      <div className="flex-shrink-0 p-4">
        <div className="flex gap-2 items-end bg-white rounded-lg shadow-md border border-slate-200 p-4">
          <input
            type="text"
            className="flex-1 bg-transparent px-3 py-2 focus:outline-none text-sm"
            placeholder="Type a message to test..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading || selectedModels.length === 0 || disabled}
          />
          {/* Keyboard shortcut hint */}
          <span className="text-xs text-gray-400 self-center mr-1 flex-shrink-0">↵</span>
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim() || selectedModels.length === 0 || disabled}
            className="p-2 rounded-md transition-colors flex items-center justify-center flex-shrink-0 bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatPanel;
