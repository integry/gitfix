import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ModelSelector, { type AgentModelOption } from './ModelSelector';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

const options: AgentModelOption[] = Array.from({ length: 12 }, (_, index) => ({
  agentId: `agent-${index}`,
  agentAlias: `Agent ${index}`,
  modelId: `model-${index}`,
  modelName: `Model ${index}`,
}));

describe('ModelSelector keyboard navigation', () => {
  afterEach(() => {
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('scrolls to and selects an active option beyond the initial viewport', () => {
    const scrolledOptionIds: string[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(function scrollIntoView(this: HTMLElement) {
        scrolledOptionIds.push(this.id);
      }),
    });
    const onSelectedModelsChange = vi.fn();

    render(
      <ModelSelector
        options={options}
        selectedModels={[]}
        onSelectedModelsChange={onSelectedModelsChange}
        onClear={vi.fn()}
      />,
    );

    const combobox = screen.getByRole('combobox', { name: 'Search and add models to compare' });
    fireEvent.focus(combobox);
    for (let index = 0; index < 8; index += 1) {
      fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    }

    const activeOption = screen.getByRole('option', { name: /Model 8/ });
    expect(combobox).toHaveAttribute('aria-activedescendant', activeOption.id);
    expect(scrolledOptionIds.at(-1)).toBe(activeOption.id);

    fireEvent.keyDown(combobox, { key: 'Enter' });
    expect(onSelectedModelsChange).toHaveBeenCalledWith([
      { agentId: 'agent-8', modelId: 'model-8' },
    ]);
  });
});
